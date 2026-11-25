use socket2::{Domain, Protocol, Socket, Type};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

struct Helper(Child);

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn line(output: &Receiver<io::Result<String>>) -> io::Result<String> {
    output
        .recv_timeout(Duration::from_secs(3))
        .map_err(io::Error::other)?
}

fn field<'a>(line: &'a str, name: &str) -> io::Result<&'a str> {
    line.split_once(&format!("\"{name}\":"))
        .and_then(|(_, value)| value.split([',', '}']).next())
        .ok_or_else(|| io::Error::other(format!("missing {name} in {line}")))
}

fn number<T: std::str::FromStr>(line: &str, name: &str) -> io::Result<T> {
    field(line, name)?
        .parse()
        .map_err(|_| io::Error::other(format!("invalid {name} in {line}")))
}

#[test]
fn native_proxy_reports_readbacks_pauses_upstream_then_drains() -> io::Result<()> {
    let server = TcpListener::bind("127.0.0.1:0")?;
    let reference = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    reference.set_recv_buffer_size(16_384)?;
    let before = reference.recv_buffer_size()?;
    reference.connect_timeout(&server.local_addr()?.into(), Duration::from_secs(2))?;
    let after = reference.recv_buffer_size()?;
    let _ = server.accept()?;
    let mut helper = Helper(
        Command::new(env!("CARGO_BIN_EXE_fukulow-stall-helper"))
            .args([server.local_addr()?.port().to_string(), "2".into()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?,
    );
    let mut input = helper
        .0
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("no stdin"))?;
    let stdout = helper
        .0
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("no stdout"))?;
    let (records, output) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if records.send(line).is_err() {
                break;
            }
        }
    });
    let listeners = [line(&output)?, line(&output)?];
    let attach = |id: usize| -> io::Result<(u16, TcpStream, TcpStream)> {
        let listening = &listeners[id];
        assert_eq!(field(listening, "event")?, "\"listening\"");
        assert_eq!(number::<usize>(listening, "socket")?, id);
        let port: u16 = number(listening, "port")?;
        let client = TcpStream::connect(("127.0.0.1", port))?;
        let connected = line(&output)?;
        assert_eq!(field(&connected, "event")?, "\"connected\"");
        assert_eq!(number::<usize>(&connected, "socket")?, id);
        assert_eq!(number::<usize>(&connected, "before")?, before);
        assert_eq!(number::<usize>(&connected, "after")?, after);
        let (upstream, _) = server.accept()?;
        Ok((port, client, upstream))
    };
    let (port, mut client, mut upstream) = attach(0)?;
    let (_, _other_client, _other_upstream) = attach(1)?;
    client.set_read_timeout(Some(Duration::from_secs(2)))?;
    upstream.set_read_timeout(Some(Duration::from_secs(2)))?;
    upstream.set_write_timeout(Some(Duration::from_millis(200)))?;
    socket2::SockRef::from(&upstream).set_send_buffer_size(16_384)?;

    upstream.write_all(b"warm")?;
    let mut warm = [0; 4];
    client.read_exact(&mut warm)?;
    assert_eq!(&warm, b"warm");
    assert_eq!(field(&line(&output)?, "event")?, "\"read\"");

    writeln!(input, "pause")?;
    assert_eq!(field(&line(&output)?, "command")?, "\"pause\"");
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    client.write_all(b"pong")?;
    let mut pong = [0; 4];
    upstream.read_exact(&mut pong)?;
    assert_eq!(&pong, b"pong");

    let chunk = [b'x'; 8_192];
    let mut written = 0;
    while written < 2 * 1024 * 1024 {
        match upstream.write(&chunk) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(n) => written += n,
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                break;
            }
            Err(e) => return Err(e),
        }
    }
    assert!(
        written > 0 && written < 2 * 1024 * 1024,
        "paused upstream did not back up"
    );
    client.set_nonblocking(true)?;
    assert_eq!(
        client.read(&mut warm).err().map(|e| e.kind()),
        Some(io::ErrorKind::WouldBlock)
    );
    client.set_nonblocking(false)?;

    writeln!(input, "resume")?;
    let mut resume = None;
    let mut first_read = f64::INFINITY;
    let mut reads = 0;
    while resume.is_none() || reads < written {
        let record = line(&output)?;
        match field(&record, "event")? {
            "\"ack\"" => {
                assert_eq!(field(&record, "command")?, "\"resume\"");
                resume = Some(number::<f64>(&record, "at")?);
                // Drain concurrently with any further upstream reads.
                let mut received = vec![0; written];
                client.read_exact(&mut received)?;
                assert!(received.iter().all(|&byte| byte == b'x'));
            }
            "\"read\"" => {
                first_read = first_read.min(number(&record, "at")?);
                reads += number::<usize>(&record, "bytes")?;
            }
            other => return Err(io::Error::other(format!("unexpected event {other}"))),
        }
    }
    assert_eq!(reads, written);
    assert!(resume.is_some_and(|at| at <= first_read));
    upstream.shutdown(Shutdown::Both)?;
    let close = line(&output)?;
    assert_eq!(field(&close, "event")?, "\"close\"");
    assert_eq!(field(&close, "side")?, "\"upstream\"");
    writeln!(input, "quit")?;
    assert!(helper.0.wait()?.success());
    Ok(())
}
