//! Protocol-layer benchmarks for the IPC v0 frame codec.
//!
//! Covers the hot paths the host and worker both pay on every frame:
//! header+payload encoding, header decoding, the encode/decode round trip,
//! `MORE` fragment reassembly, and CRC32C checksumming. Run with
//! `cargo bench` from `chimera-host/`; `target/criterion/` holds the report.

use criterion::{black_box, criterion_group, criterion_main, BatchSize, Criterion, Throughput};

use chimera_host::crc32c::crc32c;
use chimera_host::frame::{
    decode_header, FrameKind, Header, Reassembler, FLAG_MORE, HEADER_LEN, PROTOCOL_VERSION_V0,
};

/// Payload sizes exercised by the encode/decode groups: empty, one header
/// worth, one page, and a full 1 MiB body.
const PAYLOAD_SIZES: [(&str, usize); 4] = [
    ("0", 0),
    ("64", 64),
    ("4096", 4096),
    ("1MiB", 1024 * 1024),
];

/// Fragment count/size for the reassembly group: 64 × 4 KiB = 256 KiB message,
/// well under both `MAX_FRAGMENTS` and `MAX_REASSEMBLED_BYTES`.
const REASSEMBLE_FRAGMENTS: usize = 64;
const REASSEMBLE_FRAGMENT_BYTES: usize = 4096;

fn header(payload_len: usize, flags: u16) -> Header {
    Header {
        protocol_version: PROTOCOL_VERSION_V0,
        frame_kind: FrameKind::Request,
        flags,
        payload_length: payload_len as u32,
        connection_id: 1,
        worker_generation: 7,
        sequence: 1,
        correlation_id: [0x5a; 16],
        payload_crc32c: 0,
    }
}

fn bench_frame_encode(c: &mut Criterion) {
    let mut group = c.benchmark_group("frame_encode");
    for (label, len) in PAYLOAD_SIZES {
        let payload = vec![0xABu8; len];
        let header = header(len, 0);
        group.throughput(Throughput::Bytes(len as u64));
        group.bench_function(label, |b| {
            b.iter(|| black_box(header.encode(black_box(&payload))));
        });
    }
    group.finish();
}

fn bench_header_decode(c: &mut Criterion) {
    let mut group = c.benchmark_group("header_decode");
    for (label, len) in PAYLOAD_SIZES {
        let frame = header(len, 0).encode(&vec![0xCDu8; len]);
        group.throughput(Throughput::Bytes(len as u64));
        group.bench_function(label, |b| {
            b.iter(|| black_box(decode_header(black_box(&frame)).expect("valid frame")));
        });
    }
    group.finish();
}

fn bench_frame_roundtrip(c: &mut Criterion) {
    let mut group = c.benchmark_group("frame_roundtrip");
    for (label, len) in PAYLOAD_SIZES {
        let payload = vec![0xEFu8; len];
        let header = header(len, 0);
        group.throughput(Throughput::Bytes(len as u64));
        group.bench_function(label, |b| {
            b.iter(|| {
                let encoded = header.encode(black_box(&payload));
                black_box(decode_header(&encoded).expect("round trip decodes"))
            });
        });
    }
    group.finish();
}

fn bench_reassemble(c: &mut Criterion) {
    // `MORE` on every fragment but the last, mirroring a real split message.
    let fragments: Vec<(Header, Vec<u8>)> = (0..REASSEMBLE_FRAGMENTS)
        .map(|index| {
            let flags = if index + 1 == REASSEMBLE_FRAGMENTS {
                0
            } else {
                FLAG_MORE
            };
            let payload = vec![index as u8; REASSEMBLE_FRAGMENT_BYTES];
            (header(REASSEMBLE_FRAGMENT_BYTES, flags), payload)
        })
        .collect();

    let mut group = c.benchmark_group("reassemble");
    group.throughput(Throughput::Bytes(
        (REASSEMBLE_FRAGMENTS * REASSEMBLE_FRAGMENT_BYTES) as u64,
    ));
    group.bench_function(
        format!("{REASSEMBLE_FRAGMENTS}x{REASSEMBLE_FRAGMENT_BYTES}"),
        |b| {
            b.iter_batched(
                Reassembler::new,
                |mut reassembler| {
                    let mut body = None;
                    for (header, payload) in &fragments {
                        body = reassembler.push(black_box(header), black_box(payload)).expect("valid fragment");
                    }
                    black_box(body)
                },
                BatchSize::SmallInput,
            );
        },
    );
    group.finish();
}

fn bench_crc32c(c: &mut Criterion) {
    let mut group = c.benchmark_group("crc32c");
    for (label, len) in [("1KiB", 1024usize), ("1MiB", 1024 * 1024)] {
        let data = vec![0x42u8; len];
        group.throughput(Throughput::Bytes(len as u64));
        group.bench_function(label, |b| {
            b.iter(|| black_box(crc32c(black_box(&data))));
        });
    }
    group.finish();
}

/// Keep `HEADER_LEN` referenced so the bench stays honest about the fixed
/// framing overhead it encodes.
const _: usize = HEADER_LEN as usize;

criterion_group!(
    benches,
    bench_frame_encode,
    bench_header_decode,
    bench_frame_roundtrip,
    bench_reassemble,
    bench_crc32c
);
criterion_main!(benches);