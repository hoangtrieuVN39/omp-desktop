//! What a paired phone may do: its scope, and the scope every phone request
//! needs. Rust checks the scope before a request reaches the webview; the
//! webview validates the request's arguments again (`app/remote-ops.js`).
//! A request missing from these tables is refused, never forwarded.

use serde::{Deserialize, Serialize};

/// Ordered: a higher scope includes everything a lower one may do.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Read everything, receive pushes.
    View,
    /// Also prompt, steer, stop, answer, queue, attach images, steer and
    /// cancel subagents, export.
    Control,
    /// Also open/close/rename tabs, switch profiles, change model and goal,
    /// branch/fork, git changes, approval rules and modes.
    Manage,
}

impl Scope {
    pub const fn allows(self, needed: Self) -> bool {
        (self as u8) >= (needed as u8)
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "view" => Some(Self::View),
            "control" => Some(Self::Control),
            "manage" => Some(Self::Manage),
            _ => None,
        }
    }
}

/// A phone's `action` kinds with the scope each needs. `select` (follow a
/// tab) is a view-level request: reading another tab needs the desktop to
/// show it.
pub const ACTIONS: &[(&str, Scope)] = &[
    ("select", Scope::View),
    // control
    ("prompt", Scope::Control),
    ("steer", Scope::Control),
    ("abort", Scope::Control),
    ("answer", Scope::Control),
    ("followUp", Scope::Control),
    ("queueRemove", Scope::Control),
    ("queuePromote", Scope::Control),
    ("queueSendNow", Scope::Control),
    ("stopRetry", Scope::Control),
    ("subagentSteer", Scope::Control),
    ("subagentCancel", Scope::Control),
    ("exportHtml", Scope::Control),
    // manage
    ("setModel", Scope::Manage),
    ("setThinking", Scope::Manage),
    ("compact", Scope::Manage),
    ("goalStart", Scope::Manage),
    ("goalOp", Scope::Manage),
    ("openProject", Scope::Manage),
    ("newTab", Scope::Manage),
    ("resumeSession", Scope::Manage),
    ("closeTab", Scope::Manage),
    ("renameTab", Scope::Manage),
    ("switchProfile", Scope::Manage),
    ("branchAt", Scope::Manage),
    ("forkAt", Scope::Manage),
    ("gitAccept", Scope::Manage),
    ("gitReject", Scope::Manage),
    ("gitSwitchBranch", Scope::Manage),
    ("approvalRevoke", Scope::Manage),
    ("approvalModeProject", Scope::Manage),
];

/// A phone's read-only `query` names; every one is view-level.
pub const QUERIES: &[&str] = &[
    "projects",
    "profiles",
    "savedSessions",
    "models",
    "thinkingLevels",
    "commands",
    "files",
    "toolOutput",
    "gitStatus",
    "gitFile",
    "gitLog",
    "gitBranches",
    "readFile",
    "prStatus",
    "subagentTranscript",
    "usage",
    "approvalRules",
    "approvalModes",
    "conversationTree",
];

/// The scope an action kind needs; `None` for an unknown kind.
pub fn action_scope(kind: &str) -> Option<Scope> {
    ACTIONS
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(_, scope)| *scope)
}

/// The scope a query needs; `None` for an unknown query.
pub fn query_scope(name: &str) -> Option<Scope> {
    QUERIES.contains(&name).then_some(Scope::View)
}

/// Why a request was refused before it reached the webview.
pub const NOT_ALLOWED: &str = "not allowed";
pub const UNKNOWN_REQUEST: &str = "unknown request";

/// Check `needed` against the device's current scope (`None`: the device is
/// gone). The error is what the phone's ack says.
pub fn check(current: Option<Scope>, needed: Option<Scope>) -> Result<(), &'static str> {
    let needed = needed.ok_or(UNKNOWN_REQUEST)?;
    let current = current.ok_or("device revoked")?;
    if current.allows(needed) {
        Ok(())
    } else {
        Err(NOT_ALLOWED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_are_ordered_and_inclusive() {
        assert!(Scope::Manage.allows(Scope::Control));
        assert!(Scope::Manage.allows(Scope::View));
        assert!(Scope::Control.allows(Scope::View));
        assert!(!Scope::View.allows(Scope::Control));
        assert!(!Scope::Control.allows(Scope::Manage));
    }

    #[test]
    fn check_refuses_unknown_requests_revoked_devices_and_low_scopes() {
        assert_eq!(check(Some(Scope::Manage), None), Err(UNKNOWN_REQUEST));
        assert_eq!(
            check(None, Some(Scope::View)),
            Err("device revoked"),
            "a vanished device never passes"
        );
        assert_eq!(
            check(Some(Scope::View), action_scope("prompt")),
            Err(NOT_ALLOWED)
        );
        assert_eq!(
            check(Some(Scope::Control), action_scope("gitReject")),
            Err(NOT_ALLOWED)
        );
        assert_eq!(check(Some(Scope::Control), action_scope("prompt")), Ok(()));
        assert_eq!(check(Some(Scope::View), query_scope("gitStatus")), Ok(()));
        assert_eq!(check(Some(Scope::View), action_scope("select")), Ok(()));
    }

    #[test]
    fn tables_have_no_duplicates_and_parse_round_trips() {
        let mut names: Vec<&str> = ACTIONS.iter().map(|(name, _)| *name).collect();
        names.extend(QUERIES);
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count, "an action and a query share a name");
        for scope in [Scope::View, Scope::Control, Scope::Manage] {
            let text = serde_json::to_value(scope).unwrap();
            assert_eq!(Scope::parse(text.as_str().unwrap()), Some(scope));
        }
        assert_eq!(Scope::parse("admin"), None);
    }

    #[test]
    fn legacy_remote_actions_keep_their_scope() {
        for kind in ["prompt", "steer", "abort", "answer"] {
            assert_eq!(action_scope(kind), Some(Scope::Control), "{kind}");
        }
    }
}
