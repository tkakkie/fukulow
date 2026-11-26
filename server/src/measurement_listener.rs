use socket2::SockRef;
use std::{io, net::Shutdown};
use tokio::net::TcpStream;

pub(super) const SEND_BUFFER_ENV: &str = "FUKULOW_MEASUREMENT_SNDBUF";

pub(super) fn send_buffer(value: Option<&str>) -> Result<Option<usize>, &'static str> {
    value
        .map(|value| {
            value
                .parse::<i32>()
                .ok()
                .filter(|size| *size > 0 && value.bytes().all(|byte| byte.is_ascii_digit()))
                .map(|size| size as usize)
                .ok_or("FUKULOW_MEASUREMENT_SNDBUF must be an integer from 1 to 2147483647")
        })
        .transpose()
}

pub(super) fn apply(stream: &TcpStream, requested: Option<usize>) {
    let Some(requested) = requested else {
        return;
    };
    let socket = SockRef::from(stream);
    match apply_and_read_back(&socket, requested) {
        Ok((peer_port, effective)) => {
            tracing::info!(target: "fukulow", event = "measurement_send_buffer", peer_port, effective);
        }
        Err(_) => {
            tracing::warn!(target: "fukulow", event = "measurement_send_buffer_failed");
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

fn apply_and_read_back(socket: &SockRef<'_>, requested: usize) -> io::Result<(u16, usize)> {
    socket.set_send_buffer_size(requested)?;
    let effective = socket.send_buffer_size()?;
    let peer_port = socket
        .peer_addr()?
        .as_socket()
        .ok_or(io::ErrorKind::InvalidData)?
        .port();
    Ok((peer_port, effective))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn unset_send_buffer_leaves_the_accepted_socket_unchanged() -> io::Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let _client = TcpStream::connect(listener.local_addr()?).await?;
        let (stream, _) = listener.accept().await?;
        let before = SockRef::from(&stream).send_buffer_size()?;
        assert_eq!(send_buffer(None), Ok(None));
        apply(&stream, None);
        assert_eq!(SockRef::from(&stream).send_buffer_size()?, before);
        Ok(())
    }

    #[tokio::test]
    async fn configured_send_buffer_reads_back_the_accepted_socket() -> io::Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let client = TcpStream::connect(listener.local_addr()?).await?;
        let (stream, _) = listener.accept().await?;
        let socket = SockRef::from(&stream);
        let reference = SockRef::from(&client);
        reference.set_send_buffer_size(16_384)?;
        let (peer_port, effective) = apply_and_read_back(&socket, 16_384)?;
        assert_eq!(peer_port, client.local_addr()?.port());
        assert_eq!(effective, reference.send_buffer_size()?);
        assert_eq!(socket.send_buffer_size()?, effective);
        assert!(effective > 0);
        Ok(())
    }
}
