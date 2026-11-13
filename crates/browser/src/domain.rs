//! Domain model for the browser tools: tabs with generation-stamped
//! references, element references bound to a snapshot, and snapshot output.

use serde::{Deserialize, Serialize};

/// Stable handle for a tab inside one session. Contains a generation counter
/// so references from an older snapshot of the page are detectably stale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabId {
    pub raw: String,
    pub generation: u64,
}

impl TabId {
    #[must_use]
    pub fn new(raw: impl Into<String>, generation: u64) -> Self {
        Self {
            raw: raw.into(),
            generation,
        }
    }
}

/// Model-facing spelling of a tab reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabRef {
    pub tab_id: TabId,
    pub label: String,
}

impl TabRef {
    #[must_use]
    pub fn new(tab_id: TabId, label: impl Into<String>) -> Self {
        Self {
            tab_id,
            label: label.into(),
        }
    }
}

/// Element reference returned by a snapshot. `generation` matches the
/// snapshot's page generation: any navigation bumps the generation and
/// invalidates every outstanding element reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ElementRef {
    pub tab: String,
    pub generation: u64,
    pub ordinal: u32,
}

impl ElementRef {
    #[must_use]
    pub fn new(tab: impl Into<String>, generation: u64, ordinal: u32) -> Self {
        Self {
            tab: tab.into(),
            generation,
            ordinal,
        }
    }
}

/// One node of the accessibility-style snapshot tree. Node values are
/// UNTRUSTED page content: the engine redacts before display/logging.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotNode {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub children: Vec<SnapshotNode>,
}

/// Accessibility snapshot of a page at one generation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub tab: String,
    pub generation: u64,
    pub url: String,
    pub title: Option<String>,
    pub nodes: Vec<SnapshotNode>,
    /// Total node count including children, pre-bounding.
    pub node_count: usize,
}

impl Snapshot {
    /// Depth-first flat list of nodes, bounded to `limit`.
    pub fn bounded_nodes(&self, limit: usize) -> Vec<&SnapshotNode> {
        let mut out = Vec::new();
        fn walk<'a>(node: &'a SnapshotNode, out: &mut Vec<&'a SnapshotNode>, limit: usize) {
            if out.len() >= limit {
                return;
            }
            out.push(node);
            for child in &node.children {
                walk(child, out, limit);
            }
        }
        for node in &self.nodes {
            walk(node, &mut out, limit);
        }
        out
    }
}
