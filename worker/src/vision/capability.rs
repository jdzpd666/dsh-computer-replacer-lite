//! Capability probe for `locate`: which detection channels this worker can use.
//!
//! The locate tool has a strict two-channel contract (plan §2.2/§3):
//!
//! * `fusion`  — UIA elements fused with OCR text. Requires both screen capture and
//!                the WinRT OCR engine.
//! * `uia_only` — UIA elements only, label matching. This is the degraded channel and
//!                is always usable because observations are pure UIA reads.
//!
//! Grounding (image-based element grounding) is intentionally not implemented in batch 4,
//! so `grounding` is always reported as `false` (plan §7).
//!
//! Everything in this module is a pure function so the channel decision can be tested
//! without a real capture device or OCR engine.

use serde_json::{json, Value};

/// Fixed error code reported when the fusion channel cannot be used.
///
/// Reuses the existing worker error code set (plan §3: no new codes).
pub const CODE_VISION_UNAVAILABLE: &str = "VISION_UNAVAILABLE";

/// Which detection channels are available in this worker process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    /// Screen capture is available (DXGI stream can deliver a frame).
    pub capture: bool,
    /// The WinRT OCR engine is available (language packs present).
    pub ocr: bool,
    /// Image-based element grounding. Always `false` in batch 4.
    pub grounding: bool,
}

impl Capabilities {
    /// Capabilities for a worker where capture and OCR are both usable.
    pub fn fusion() -> Self {
        Self { capture: true, ocr: true, grounding: false }
    }

    /// Capabilities for the UIA-only degraded channel.
    pub fn uia_only() -> Self {
        Self { capture: false, ocr: false, grounding: false }
    }

    /// The contract §3 `capabilities` object: exactly `capture`, `ocr`, `grounding`.
    pub fn json(self) -> Value {
        json!({
            "capture": self.capture,
            "ocr": self.ocr,
            "grounding": self.grounding,
        })
    }
}

/// The contract §3 `channel` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    /// UIA elements fused with OCR text.
    Fusion,
    /// UIA elements only (degraded).
    UiaOnly,
}

impl Channel {
    /// Wire representation, exactly `"fusion"` / `"uia_only"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Fusion => "fusion",
            Channel::UiaOnly => "uia_only",
        }
    }

    /// Whether this channel is degraded relative to a full fusion response.
    pub fn is_degraded(self) -> bool {
        self == Channel::UiaOnly
    }
}

/// Picks the strongest channel the worker can currently provide.
///
/// Fusion needs both halves, so a missing capture device *or* a missing OCR engine
/// falls back to UIA-only label matching.
pub fn choose_channel(capabilities: Capabilities) -> Channel {
    if capabilities.capture && capabilities.ocr {
        Channel::Fusion
    } else {
        Channel::UiaOnly
    }
}

/// Capability-driven `degradeReason`: `None` for a full fusion response, otherwise
/// `"<CODE>: <message>"` naming the missing half (contract §3).
pub fn degrade_reason(capabilities: Capabilities) -> Option<String> {
    if choose_channel(capabilities) == Channel::Fusion {
        return None;
    }
    let message = if !capabilities.capture {
        "screen capture is unavailable"
    } else {
        "OCR engine is unavailable"
    };
    Some(fault_reason(CODE_VISION_UNAVAILABLE, message))
}

/// Formats a fault as the contract §3 `degradeReason`: `"<CODE>: <message>"`.
///
/// The handler uses this for runtime faults (capture failure, OCR timeout, vision busy)
/// so every degraded response carries the same shape.
pub fn fault_reason(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fusion_capabilities_select_fusion_channel_without_degrade_reason() {
        let capabilities = Capabilities::fusion();
        assert_eq!(choose_channel(capabilities), Channel::Fusion);
        assert!(!Channel::Fusion.is_degraded());
        assert_eq!(degrade_reason(capabilities), None);
        assert_eq!(Channel::Fusion.as_str(), "fusion");
        assert_eq!(
            capabilities.json(),
            json!({"capture": true, "ocr": true, "grounding": false})
        );
    }

    #[test]
    fn missing_ocr_degrades_to_uia_only_and_the_reason_says_ocr() {
        let capabilities = Capabilities { capture: true, ocr: false, grounding: false };
        assert_eq!(choose_channel(capabilities), Channel::UiaOnly);
        assert!(Channel::UiaOnly.is_degraded());
        assert_eq!(Channel::UiaOnly.as_str(), "uia_only");
        let reason = degrade_reason(capabilities).expect("degraded channel must explain itself");
        assert_eq!(reason, "VISION_UNAVAILABLE: OCR engine is unavailable");
        assert!(reason.starts_with("VISION_UNAVAILABLE: "), "reason is \"<CODE>: <message>\"");
        assert_eq!(
            capabilities.json(),
            json!({"capture": true, "ocr": false, "grounding": false})
        );
    }

    #[test]
    fn missing_capture_degrades_to_uia_only_and_the_reason_says_capture() {
        let capabilities = Capabilities { capture: false, ocr: true, grounding: false };
        assert_eq!(choose_channel(capabilities), Channel::UiaOnly);
        let reason = degrade_reason(capabilities).expect("degraded channel must explain itself");
        assert_eq!(reason, "VISION_UNAVAILABLE: screen capture is unavailable");
    }

    #[test]
    fn runtime_faults_use_the_same_reason_shape() {
        assert_eq!(
            fault_reason("VISION_TIMEOUT", "vision reply timed out after 14s"),
            "VISION_TIMEOUT: vision reply timed out after 14s"
        );
        assert_eq!(fault_reason("INVALID_ARGUMENT", "bad region"), "INVALID_ARGUMENT: bad region");
    }
}
