// Submitted-code stand-in for the #420 isolation test: a build script is the
// earliest point arbitrary repository code runs during a build. It tries DNS
// and a direct TCP connection, then fails the build with a marker the test
// reads from the private build log. Either path reaching the network prints
// CONNECTED; the sandbox must always produce BLOCKED.
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

fn main() {
    let dns = "example.com:443".to_socket_addrs().map(|mut a| a.next().is_some());
    let addr: SocketAddr = "1.1.1.1:443".parse().unwrap();
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(5));
    if matches!(dns, Ok(true)) || tcp.is_ok() {
        panic!("VELLAR_NET_PROBE=CONNECTED dns={:?} tcp={:?}", dns, tcp.map(|_| ()));
    }
    panic!("VELLAR_NET_PROBE=BLOCKED dns={:?} tcp={:?}", dns, tcp.map(|_| ()));
}
