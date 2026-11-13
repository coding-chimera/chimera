//! Wire layout tests: every row encodes to its declared byte size and
//! round-trips through decode without byte drift.

mod abi;
mod ctx;
mod extract;
mod resolve;
mod store;
