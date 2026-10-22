//! CRC32C (Castagnoli) with the reflected polynomial `0x82F63B78`.
//!
//! Table-driven, no external dependencies. The table is built at compile time
//! via `const fn`, so runtime cost is one table lookup per byte.

const POLYNOMIAL: u32 = 0x82F6_3B78;

const fn build_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ POLYNOMIAL
            } else {
                crc >> 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

static TABLE: [u32; 256] = build_table();

/// Compute the CRC32C of `data` (standard init/final XOR of `0xFFFF_FFFF`).
///
/// Known vector: `crc32c(b"123456789") == 0xE306_9283`.
pub fn crc32c(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in data {
        crc = TABLE[((crc ^ byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::crc32c;

    #[test]
    fn known_vector() {
        assert_eq!(crc32c(b"123456789"), 0xE306_9283);
    }

    #[test]
    fn empty_input_is_zero() {
        assert_eq!(crc32c(b""), 0);
    }

    #[test]
    fn single_byte_matches_reference_table() {
        // Reference value for 0x00: init !0, one lookup with 0x00, final XOR.
        assert_eq!(crc32c(&[0x00]), 0x527D_5351);
    }
}