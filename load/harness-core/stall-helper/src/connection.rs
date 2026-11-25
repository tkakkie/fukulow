use crate::read_gate::ReadGate;
use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const RECEIVE_BUFFER: usize = 16_384;
const READ_TIMEOUT: Duration = Duration::from_millis(25);

struct Connected {
    stream: TcpStream,
    before: usize,
    after: usize,
}

fn connect(
    address: SocketAddr,
    dial: impl FnOnce(&Socket, &SockAddr) -> io::Result<()>,
) -> io::Result<Connected> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_recv_buffer_size(RECEIVE_BUFFER)?;
    let before = socket.recv_buffer_size()?;
    dial(&socket, &address.into())?;
    let after = socket.recv_buffer_size()?;
    let stream: TcpStream = socket.into();
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    Ok(Connected {
        stream,
        before,
        after,
    })
}

pub fn serve(
    listener: TcpListener,
    address: SocketAddr,
    id: usize,
    gate: Arc<ReadGate>,
    clock: Instant,
) -> io::Result<()> {
    let (client, _) = listener.accept()?;
    drop(listener); // One registration per port.
    let Connected {
        stream: mut upstream,
        before,
        after,
    } = connect(address, |socket, address| {
        socket.connect_timeout(address, Duration::from_secs(5))
    })?;
    client.set_nodelay(true)?;
    writeln!(
        io::stdout().lock(),
        r#"{{"event":"connected","socket":{id},"before":{before},"after":{after}}}"#,
    )?;

    let (mut client_read, mut upstream_write) = (client.try_clone()?, upstream.try_clone()?);
    let closed = Arc::new(AtomicBool::new(false));
    let writer_closed = Arc::clone(&closed);
    thread::Builder::new().spawn(move || {
        let _ = io::copy(&mut client_read, &mut upstream_write);
        close(
            id,
            "client",
            clock,
            &writer_closed,
            &client_read,
            &upstream_write,
        )
    })?;

    let mut client = client;
    let forwarded = forward(&gate, &mut upstream, &mut client, clock, |bytes, at| {
        writeln!(
            io::stdout().lock(),
            r#"{{"event":"read","socket":{id},"at":{at},"bytes":{bytes}}}"#,
        )
    });
    let ended = close(id, "upstream", clock, &closed, &client, &upstream);
    forwarded.and(ended)
}

fn forward(
    gate: &ReadGate,
    upstream: &mut TcpStream,
    client: &mut TcpStream,
    clock: Instant,
    report: impl Fn(usize, f64) -> io::Result<()>,
) -> io::Result<()> {
    let mut buffer = [0; 16_384];
    loop {
        match gate.read(|| {
            let n = upstream.read(&mut buffer)?;
            Ok((n, clock.elapsed().as_secs_f64() * 1000.0))
        }) {
            Ok((0, _)) => return Ok(()),
            Ok((n, at)) => {
                report(n, at)?;
                client.write_all(&buffer[..n])?;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(e),
        }
    }
}

fn close(
    id: usize,
    side: &str,
    clock: Instant,
    closed: &AtomicBool,
    client: &TcpStream,
    upstream: &TcpStream,
) -> io::Result<()> {
    if closed.swap(true, Ordering::Relaxed) {
        return Ok(());
    }
    let at = clock.elapsed().as_secs_f64() * 1000.0;
    let _ = client.shutdown(Shutdown::Both);
    let _ = upstream.shutdown(Shutdown::Both);
    writeln!(
        io::stdout().lock(),
        r#"{{"event":"close","socket":{id},"side":"{side}","at":{at}}}"#,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receive_buffer_is_set_before_connect_and_rechecked_after() -> io::Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let reference = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
        reference.set_recv_buffer_size(16_384)?;
        let observed = reference.recv_buffer_size()?;
        let mut changed = 0;
        let connected = connect(listener.local_addr()?, |socket, address| {
            assert!(socket.peer_addr().is_err());
            assert_eq!(socket.recv_buffer_size()?, observed);
            socket.connect(address)?;
            // Linux can return the same value before and after connect. Change it here
            // so the test also detects reuse of the pre-connect readback on Linux.
            socket.set_recv_buffer_size(8_192)?;
            // Read back immediately: macOS may auto-grow the buffer later, once the
            // peer accepts, so a later readback is not comparable.
            changed = socket.recv_buffer_size()?;
            Ok(())
        })?;
        let (_, peer) = listener.accept()?;
        assert_eq!(peer, connected.stream.local_addr()?);
        assert_eq!(connected.before, observed);
        assert_eq!(connected.after, changed);
        assert_ne!(connected.after, observed);
        Ok(())
    }
}
