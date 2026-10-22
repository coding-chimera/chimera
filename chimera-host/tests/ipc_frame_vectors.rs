//! Cross-language golden-vector parity: every frame in
//! `tests/vectors/ipc-frame-v0.hex` was produced by the TypeScript codec
//! (`packages/chimera/src/host/ipc-frame.ts`). This test decodes each frame
//! with the Rust codec, asserts every documented header field, and re-encodes
//! to byte-identical output.
//!
//! Line format (pipe-separated):
//! name | frame_hex | protocol_version | frame_kind | flags | payload_length
//! | connection_id | worker_generation | sequence | correlation_hex |
//! payload_crc32c

use chimera_host::frame::{decode_header, verify_checksum, FrameKind, FLAG_CHECKSUM};

struct Vector {
    name: String,
    frame: Vec<u8>,
    protocol_version: u16,
    frame_kind: u8,
    flags: u16,
    payload_length: u32,
    connection_id: u64,
    worker_generation: u64,
    sequence: u64,
    correlation_id: [u8; 16],
    payload_crc32c: u32,
}

fn unhex(input: &str) -> Vec<u8> {
    assert!(input.len() % 2 == 0, "hex input has odd length");
    (0..input.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&input[i..i + 2], 16).expect("hex byte"))
        .collect()
}

fn parse_vectors() -> Vec<Vector> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/ipc-frame-v0.hex"))
        .expect("vectors file");
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let columns: Vec<&str> = line.split('|').collect();
            assert_eq!(columns.len(), 11, "vector {line} has 11 columns");
            let correlation = unhex(columns[9]);
            Vector {
                name: columns[0].to_string(),
                frame: unhex(columns[1]),
                protocol_version: columns[2].parse().expect("protocol_version"),
                frame_kind: columns[3].parse().expect("frame_kind"),
                flags: columns[4].parse().expect("flags"),
                payload_length: columns[5].parse().expect("payload_length"),
                connection_id: columns[6].parse().expect("connection_id"),
                worker_generation: columns[7].parse().expect("worker_generation"),
                sequence: columns[8].parse().expect("sequence"),
                correlation_id: correlation.try_into().expect("16-byte correlation id"),
                payload_crc32c: columns[10].parse().expect("payload_crc32c"),
            }
        })
        .collect()
}

#[test]
fn golden_vectors_decode_and_reencode_byte_identically() {
    let vectors = parse_vectors();
    assert!(vectors.len() >= 20, "corpus should cover kinds, flags and sizes");

    for vector in &vectors {
        let header = decode_header(&vector.frame)
            .unwrap_or_else(|err| panic!("{}: decode failed: {err}", vector.name));

        assert_eq!(header.protocol_version, vector.protocol_version, "{}", vector.name);
        assert_eq!(header.frame_kind.as_u8(), vector.frame_kind, "{}", vector.name);
        assert_eq!(header.flags, vector.flags, "{}", vector.name);
        assert_eq!(header.payload_length, vector.payload_length, "{}", vector.name);
        assert_eq!(header.connection_id, vector.connection_id, "{}", vector.name);
        assert_eq!(header.worker_generation, vector.worker_generation, "{}", vector.name);
        assert_eq!(header.sequence, vector.sequence, "{}", vector.name);
        assert_eq!(header.correlation_id, vector.correlation_id, "{}", vector.name);

        let payload = &vector.frame[64..];
        if vector.flags & FLAG_CHECKSUM != 0 {
            assert_eq!(header.payload_crc32c, vector.payload_crc32c, "{}", vector.name);
            verify_checksum(&header, payload).unwrap_or_else(|err| panic!("{}: {err}", vector.name));
        }

        let reencoded = header.encode(payload);
        assert_eq!(reencoded, vector.frame, "{}: re-encode diverged", vector.name);
    }
}

#[test]
fn corpus_covers_all_frame_kinds() {
    let vectors = parse_vectors();
    for kind in 1..=9u8 {
        assert!(
            vectors.iter().any(|vector| vector.frame_kind == kind),
            "corpus lacks frame_kind {kind}"
        );
    }
}
