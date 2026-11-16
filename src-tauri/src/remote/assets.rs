//! The phone page and the shared libraries it loads, compiled into the binary.

pub struct Asset {
    pub content_type: &'static str,
    pub body: &'static [u8],
}

const JS: &str = "text/javascript; charset=utf-8";

/// Resolve a request path (no query string). Everything else is `None` (404).
pub fn lookup(path: &str) -> Option<Asset> {
    let (content_type, body): (&'static str, &'static [u8]) = match path {
        "/" | "/index.html" => (
            "text/html; charset=utf-8",
            include_bytes!("../../../src/remote/index.html"),
        ),
        "/remote.js" => (JS, include_bytes!("../../../src/remote/remote.js")),
        "/client.js" => (JS, include_bytes!("../../../src/remote/client.js")),
        "/protocol.js" => (JS, include_bytes!("../../../src/remote/protocol.js")),
        "/scanner.js" => (JS, include_bytes!("../../../src/remote/scanner.js")),
        "/sessions.js" => (JS, include_bytes!("../../../src/remote/sessions.js")),
        "/view-model.js" => (JS, include_bytes!("../../../src/remote/view-model.js")),
        "/icons.js" => (JS, include_bytes!("../../../src/remote/icons.js")),
        "/ui-parts.js" => (JS, include_bytes!("../../../src/remote/ui-parts.js")),
        "/ui-sheet.js" => (JS, include_bytes!("../../../src/remote/ui-sheet.js")),
        "/ui-feedback.js" => (JS, include_bytes!("../../../src/remote/ui-feedback.js")),
        "/ui-shell.js" => (JS, include_bytes!("../../../src/remote/ui-shell.js")),
        "/connection.js" => (JS, include_bytes!("../../../src/remote/connection.js")),
        "/ctx.js" => (JS, include_bytes!("../../../src/remote/ctx.js")),
        "/connection-screen.js" => (
            JS,
            include_bytes!("../../../src/remote/connection-screen.js"),
        ),
        "/pairing.js" => (JS, include_bytes!("../../../src/remote/pairing.js")),
        "/new-session.js" => (JS, include_bytes!("../../../src/remote/new-session.js")),
        "/session-menu.js" => (JS, include_bytes!("../../../src/remote/session-menu.js")),
        "/profile-switch.js" => (JS, include_bytes!("../../../src/remote/profile-switch.js")),
        "/tokens.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/tokens.css"),
        ),
        "/ui.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/ui.css"),
        ),
        "/shell.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/shell.css"),
        ),
        "/screens.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/screens.css"),
        ),
        "/chat-logic.js" => (JS, include_bytes!("../../../src/remote/chat-logic.js")),
        "/chat-asks-logic.js" => (JS, include_bytes!("../../../src/remote/chat-asks-logic.js")),
        "/tool-output-logic.js" => (
            JS,
            include_bytes!("../../../src/remote/tool-output-logic.js"),
        ),
        "/info-model.js" => (JS, include_bytes!("../../../src/remote/info-model.js")),
        "/agents-model.js" => (JS, include_bytes!("../../../src/remote/agents-model.js")),
        "/agent-actions.js" => (JS, include_bytes!("../../../src/remote/agent-actions.js")),
        "/review-model.js" => (JS, include_bytes!("../../../src/remote/review-model.js")),
        "/diff-model.js" => (JS, include_bytes!("../../../src/remote/diff-model.js")),
        "/tree-model.js" => (JS, include_bytes!("../../../src/remote/tree-model.js")),
        "/chat-transcript.js" => (JS, include_bytes!("../../../src/remote/chat-transcript.js")),
        "/chat-asks.js" => (JS, include_bytes!("../../../src/remote/chat-asks.js")),
        "/chat-composer.js" => (JS, include_bytes!("../../../src/remote/chat-composer.js")),
        "/chat.js" => (JS, include_bytes!("../../../src/remote/chat.js")),
        "/chat-message-menu.js" => (
            JS,
            include_bytes!("../../../src/remote/chat-message-menu.js"),
        ),
        "/chat-model-sheet.js" => (
            JS,
            include_bytes!("../../../src/remote/chat-model-sheet.js"),
        ),
        "/tool-output-screen.js" => (
            JS,
            include_bytes!("../../../src/remote/tool-output-screen.js"),
        ),
        "/review.js" => (JS, include_bytes!("../../../src/remote/review.js")),
        "/review-files.js" => (JS, include_bytes!("../../../src/remote/review-files.js")),
        "/review-branch.js" => (JS, include_bytes!("../../../src/remote/review-branch.js")),
        "/diff-screen.js" => (JS, include_bytes!("../../../src/remote/diff-screen.js")),
        "/agents.js" => (JS, include_bytes!("../../../src/remote/agents.js")),
        "/subagent.js" => (JS, include_bytes!("../../../src/remote/subagent.js")),
        "/tree.js" => (JS, include_bytes!("../../../src/remote/tree.js")),
        "/export.js" => (JS, include_bytes!("../../../src/remote/export.js")),
        "/info-screens.js" => (JS, include_bytes!("../../../src/remote/info-screens.js")),
        "/conversation-tree-graph.js" => (
            JS,
            include_bytes!("../../../src/app/conversation-tree-graph.js"),
        ),
        "/conversation-tree.js" => (JS, include_bytes!("../../../src/app/conversation-tree.js")),
        "/chat-sheets.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/chat-sheets.css"),
        ),
        "/output.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/output.css"),
        ),
        "/review.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/review.css"),
        ),
        "/agents.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/agents.css"),
        ),
        "/tree.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/tree.css"),
        ),
        "/chat-screen.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/chat-screen.css"),
        ),
        "/jsQR.js" => (JS, include_bytes!("../../../src/remote/jsQR.js")),
        "/sw.js" => (JS, include_bytes!("../../../src/remote/sw.js")),
        "/remote.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/remote/remote.css"),
        ),
        "/styles.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/design/styles.css"),
        ),
        "/chat.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/design/layout/chat.css"),
        ),
        "/ask.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/design/layout/ask.css"),
        ),
        "/composer.css" => (
            "text/css; charset=utf-8",
            include_bytes!("../../../src/design/layout/composer.css"),
        ),
        "/accent.js" => (JS, include_bytes!("../../../src/app/accent.js")),
        "/scroll-pin.js" => (JS, include_bytes!("../../../src/app/scroll-pin.js")),
        "/manifest.json" => (
            "application/manifest+json",
            include_bytes!("../../../src/remote/manifest.json"),
        ),
        "/marked.min.js" => (JS, include_bytes!("../../../src/marked.min.js")),
        "/highlight.min.js" => (JS, include_bytes!("../../../src/highlight.min.js")),
        "/marked-setup.js" => (JS, include_bytes!("../../../src/app/marked-setup.js")),
        _ => return None,
    };
    Some(Asset { content_type, body })
}
