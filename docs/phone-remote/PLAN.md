# Plan: Fork OMP Desktop — Remote điện thoại đầy đủ tính năng

> Trạng thái: **Giai đoạn 0–1 xong phần không cần thiết kế**; Giai đoạn 2+ chờ thiết kế (handoff đã giao).
> Cập nhật: 2026-11-16. Tài liệu liên quan: [`DESIGN-HANDOFF.md`](DESIGN-HANDOFF.md), [`SPIKE-background-tabs.md`](SPIKE-background-tabs.md).

## Tiến độ

| Hạng mục | Trạng thái |
|---|---|
| Toolchain | rustup stable+nightly ở `D:\dev`; VS Build Tools (MSVC 14.44 + Windows SDK 26100) ở `D:\dev\BuildTools`. Chạy cargo local: `D:\dev\msvcenv.cmd cargo test --lib remote::` (target ở `D:\dev\target`). `manager_tests::a_successful_pairing_emits_a_status_with_the_device` đôi khi lỗi trên Windows khi `free_port()` trúng dải port bị loại trừ; chạy riêng thì qua (đã có sẵn, không liên quan) |
| Fork | `hoangtrieuVN39/omp-desktop`, nhánh `phone-remote`, upstream = `apoc/omp-desktop` |
| Updater riêng | pubkey + endpoint của fork; key ở `D:\dev\keys\` + GitHub secret `TAURI_SIGNING_PRIVATE_KEY`; version `0.15.0-1` |
| Giao thức v2 (Rust) | scope `view/control/manage` (kiểm tra trước webview), `query`/`result` có `data` ≤ 512 KiB, upload ảnh theo chunk, download export 1 lần, audit log, lệnh Settings đổi scope |
| Giao thức v2 (webview) | `app/remote-ops.js`: kiểm tra lại tham số + map toàn bộ action/query lên `OMP_BRIDGE`, id mờ thay cho path |
| Giao thức v2 (phone) | `src/remote/protocol.js` (`OMP_REMOTE_PROTO`): request/ack, scope gating, upload, download |
| UI điện thoại | Theo thiết kế (26 màn): shell + registry `OMP_REMOTE_UI`, Sessions/NewSession/Menu/Profile/Connection/Pairing, Chat (composer, slash/@, hàng đợi, ask, duyệt quyền, sheet model, tool output, menu tin nhắn), Review/Diff, Agents/Subagent, Tree, Export, Usage, Approvals. 3 theme (aurora/daylight/phosphor) |
| Dữ liệu thật cho UI | `buildView` xuất queue, goal, todos, subagents, model/thinking, context/cost; `branchAt`/`forkAt` tìm entry id thật qua conversation tree (không đoán); duyệt nhớ (`args.grant`) cần scope **Manage**, Rust kiểm tra, hello báo cap `approvalGrant` |
| Test | `test-remote-ops`, `test-remote-protocol`, Rust ws/server/transfers/audit/scope tests; CI + Clippy xanh |
| Giai đoạn 6 spike | xong: khuyến nghị "shadow view" trong webview (xem SPIKE doc) |
| Còn lại | kiểm thử trên iPhone thật (PWA, push, camera, share sheet), cài bản fork lên máy (cần đóng OMP Desktop), giải phóng ổ C: nếu muốn build local, shadow view cho tab nền |

## Quyết định đã chốt

| # | Chủ đề | Quyết định |
|---|---|---|
| 1 | Phạm vi | Theo bảng "Phạm vi tính năng" bên dưới; **không** terminal, browser panel, live voice, Settings đầy đủ, duyệt widget, login OAuth |
| 2 | Scope mặc định thiết bị mới | `view` (iPhone đã ghép trước fork giữ `control`) |
| 3 | Phân phối | Updater riêng của fork, ký minisign key riêng |
| 4 | Upstream | Không gửi PR/issue lên `apoc/omp-desktop`; tự merge upstream sau **mỗi** giai đoạn |
| 5 | Toolchain | Cài trên ổ D (`D:\dev\…`) |
| 6 | Thiết kế UI | Bước 0.5 = soạn handoff cho UI/UX designer; designer giao thiết kế, dev không tự thiết kế |

## Overview

Fork [apoc/omp-desktop](https://github.com/apoc/omp-desktop) để iPhone điều khiển được gần như mọi thứ desktop làm (tạo/mở lại phiên, model, ảnh, diff/git, subagent), thay bản 0.14.0 ở `D:\OMP Desktop`.

**Hiện trạng (master 0.15.0, đã kiểm tra mã):**

| Hạng mục | Thực tế |
|---|---|
| Kiến trúc | Rust (`src-tauri/`) spawn `omp --mode rpc-ui` mỗi tab; `src/live.js` (~254 KB) là bridge với `window.OMP_BRIDGE` (~150 method); React qua Babel trong webview |
| Remote hiện có | Phone → Rust hub → `remote://action` → webview thực thi qua `OMP_BRIDGE`. Rust chỉ nhận `KINDS = ["prompt","steer","abort","answer"]` (`ws/messages.rs`) + `select`; ack chỉ có `ok`/`error`, **không có dữ liệu** |
| Giới hạn | Frame ≤ 1 MiB, text ≤ 32 KiB; view = 100 tin cuối, tool output cắt 2 000 ký tự, bỏ thinking; **chỉ tab active của desktop có live view** |
| Trang phone | Plain JS (`src/remote/*.js`), nhúng binary bằng `include_bytes!` (`assets.rs`) |
| Quy ước repo (`AGENTS.md`) | Soft cap file (`.js` ~400, `.rs` ~250 dòng); logic mới bắt buộc test; clippy pedantic+nursery; RPC mới phải vào `ALLOWED_COMMAND_TYPES`; webview không gửi path/tham số git thô |
| Updater gốc | `apoc/omp-desktop/releases/latest.json` + pubkey minisign của apoc |
| Máy local | Node 24, npm, git, gh (`hoangtrieuVN39`); **chưa có Rust, chưa có MSVC Build Tools**; có Edge (đủ cho test Chromium) |

## Approach

1. **Giữ mô hình, mở rộng giao thức.** Webview vẫn là nguồn sự thật; Rust = transport/auth/scope/giới hạn; webview thực thi qua `OMP_BRIDGE`. Không tạo đường điều khiển thứ hai.
   - `hello` có `proto: 2` + `caps`; phone chỉ hiện tính năng server hỗ trợ.
   - Frame mới `query` → `result` (có `data`, ≤ 512 KiB, phân trang bằng cursor). `action` mở rộng danh sách kind.
   - Allowlist **hai lớp**: Rust (tên, scope, kích thước) + webview (kiểu/giá trị).
   - Upload ảnh theo chunk (`upload-begin/chunk/end`, 256 KiB/chunk, giới hạn tổng theo `app/image-attach.js`); không nâng giới hạn frame 1 MiB.
   - Tải file về phone (export HTML): desktop ghi file vào thư mục export riêng, phone tải qua `GET /download/<id>` dùng một lần (id ngẫu nhiên, hết hạn ngắn, gắn với thiết bị, cần token), giới hạn kích thước; phone mở share sheet iOS.
2. **Không bao giờ nhận path thô từ phone.** Project chọn theo **id** trong danh sách server cấp (recent projects + workspace root); git/file chỉ nhận project id + path tương đối/sha, Rust kiểm tra như `project_file.rs`/`git_browser/`.
3. **Scope theo thiết bị** trong `remote-devices.json`, Rust kiểm tra trước khi phát sang webview:

   | Scope | Quyền |
   |---|---|
   | `view` (mặc định) | Đọc transcript, nhận push |
   | `control` | prompt / steer / stop / trả lời câu hỏi, queue, ảnh, subagent steer/cancel |
   | `manage` | tạo/mở/đóng phiên, đổi model/goal, accept/reject git, đổi branch, approval mode/rules |

   Hành động phá huỷ: xác nhận trên phone + audit log `remote-audit.jsonl` (có giới hạn, xem trong Settings).
4. **UI phone:** giữ plain JS module như `src/remote/`; logic thuần trong `client.js`/`*-model.js`, mỗi module có `tests/test-remote-*.mjs`. Thiết kế do designer giao theo `DESIGN-HANDOFF.md`.
5. **Phân phối:** giữ `identifier: dev.ohMyPi.desktop` (dùng lại `remote.json`, thiết bị đã ghép, cert Tailscale, tab đang mở); updater trỏ release của fork, ký key riêng — đổi pubkey + endpoint **trong commit đầu tiên**.

### Phạm vi tính năng

| Nhóm | Tính năng | Bridge sẵn có | Scope |
|---|---|---|---|
| Phiên | Danh sách tab; phiên đã lưu → mở lại; tạo phiên mới trong project; đóng (guarded); đổi tên; đổi profile | `listSavedSessions`, `resumeSession`, `openSession`, `newSession`, `openProject`, `closeSessionGuarded`, `renameSession`, `switchSessionProfile` | manage |
| Composer | Model picker + MRU; thinking level; slash palette; queue follow-up (promote/remove/send now); ảnh camera/thư viện; `@` file; plan mode; goal mode; compact; dừng retry | `recentModels`, `refreshModels`, `setModel`, `thinkingLevels`, `setThinkingLevel`, `followUp`, `promoteQueuedMessage`, `removeQueuedMessage`, `sendQueuedNow`, `listFiles`, `goalStart`, `goalOp`, `compact`, `stopRetry` | control (model/goal: manage) |
| Transcript | Output tool đầy đủ theo yêu cầu; thinking bật/tắt; diff edit card; todo/plan kanban; context & chi phí; trạng thái extension widget | `getState` + view mở rộng | view |
| Subagent | Danh sách, transcript, steer, huỷ | `loadSubagentTranscript`, `steerSubagent`, `cancelSubagent` | control |
| Review & git | Status; diff toàn file; accept/reject; branch switch; xem trước file; thẻ PR/CI | `gitBrowserStatus`, `gitBrowserFile`, `gitBrowserLog`, `workspaceAccept`, `workspaceReject`, `gitBranches`, `gitSwitchBranch`, `readProjectFile`, `prAutomationSnapshot` | view (thay đổi: manage) |
| Approval | Trả lời approval kèm "nhớ cho phiên/project"; xem/thu hồi rule; approval mode theo project | `approveAndRemember`, `listApprovalRules`, `revokeApprovalRule`, `setApprovalModeProject` | manage |
| Khác | Usage; cây hội thoại (xem); xuất HTML **và tải về điện thoại**; branch/fork tại tin nhắn; mở nhánh trong tab mới | `usageStats`, `conversationTree`, `exportHtml` + endpoint tải mới, `branchAt`, `forkAt`, `resumeSession` | usage/cây: view · xuất HTML: control · branch/fork/mở nhánh: manage |

**Ngoài phạm vi:** terminal, browser panel, live voice, Settings đầy đủ, duyệt widget plugin, login OAuth.

## Key steps

```
Giai đoạn 0 (toolchain + fork) ──┐
Bước 0.5 (handoff → designer)  ──┴─► Giai đoạn 1 ─► 2 ─► 3 ─► 4 ─► 5 ─► 6 (spike) ─► 7
                                     (Giai đoạn 2+ chờ thiết kế được duyệt)
```

Mỗi giai đoạn kết thúc bằng: bản build chạy trên máy, checklist chấp nhận trên iPhone thật, merge upstream, `npm test` + `cargo test --locked` + clippy xanh.

### Giai đoạn 0 — Chuẩn bị
1. **rustup** với `RUSTUP_HOME=D:\dev\rustup`, `CARGO_HOME=D:\dev\cargo` (PATH user thêm `D:\dev\cargo\bin`); toolchain stable (≥ 1.98) + nightly (clippy).
2. **VS 2022 Build Tools** `--installPath D:\dev\VSBuildTools`, workload C++ (MSVC + Windows SDK). Windows SDK/thành phần dùng chung vẫn vào C: (vài GB) — giới hạn bộ cài Microsoft. Cần bấm UAC.
3. `gh repo fork apoc/omp-desktop`, clone vào `D:\dev\omp-desktop`, remote `upstream`, nhánh `phone-remote`.
4. Sao lưu `%APPDATA%\dev.ohMyPi.desktop`.
5. Baseline: `npm install` → `npm test` → `cargo test --locked` trên mã gốc.

### Bước 0.5 — Handoff cho UI/UX designer
- Giao [`DESIGN-HANDOFF.md`](DESIGN-HANDOFF.md). Designer trả thiết kế theo mục "Sản phẩm cần giao" trong đó.
- **Cổng duyệt:** bạn duyệt thiết kế trước Giai đoạn 2. Giai đoạn 1 chỉ cần danh sách màn hình + dữ liệu mỗi màn (đã có trong handoff) để chốt danh sách `query`.

### Giai đoạn 1 — Nền móng
1. Updater: `tauri signer generate`, đổi `pubkey` + `endpoints`; private key chỉ ở GitHub secret + password manager.
2. Version dạng `0.15.0-1` (WiX/MSI chỉ chấp nhận prerelease số; lỗi thì build NSIS).
3. Giao thức v2: hello/caps, `query`/`result`, allowlist hai lớp, scope thiết bị (migration: thiết bị cũ → `control`, mới → `view`), audit log, UI chỉnh scope trong Settings → Paired phones.
4. Upload chunk (giới hạn, timeout, dọn file tạm) + download dùng một lần cho file export.
5. CI fork chạy `tests.yml` (có thể chỉ runner Windows).
6. Test âm tính: chưa xác thực, đã thu hồi, vượt scope, frame/chunk quá cỡ, query ngoài allowlist, origin/host sai.
7. Gỡ bản gốc, cài fork (NSIS); kiểm tra tab, cert, iPhone đã ghép còn nguyên.

### Giai đoạn 2 — Quản lý phiên
Danh sách project (id), lịch sử phiên (phân trang), tạo/mở lại/đóng/đổi tên. Chọn tab trên phone vẫn đổi tab desktop cho tới Giai đoạn 6.

### Giai đoạn 3 — Composer đầy đủ
Model + thinking, slash palette (từ danh sách lệnh của phiên), queue follow-up, ảnh camera/thư viện, `@` file, plan mode, goal mode, compact.

### Giai đoạn 4 — Transcript phong phú + subagent
View gửi tóm tắt; output đầy đủ lấy qua `query` khi chạm. Diff, thinking, todo, context/chi phí, Agent Hub.

### Giai đoạn 5 — Review, git, approval
Status/diff, accept/reject (xác nhận), branch switch, preview file, thẻ PR; quản lý approval rule, approval mode theo project.

### Giai đoạn 6 — Spike: xem tab độc lập với desktop
Phone xem tab B khi desktop ở tab A. Hai hướng: (a) dựng view tab nền từ journal Rust (`agent/journal.rs`); (b) `live.js` xử lý thêm tab trong `remote://watch`. Prototype trước, rồi quyết định làm thật hay giữ hành vi đổi tab.

### Giai đoạn 7 — Hoàn thiện
Push: mute theo tab, deep-link tới câu hỏi (không chứa transcript). Nối lại + tải bù khi iOS kill app nền. CHANGELOG, cập nhật `docs/architecture/remote-access.md`, release ký trên fork.

## Risks

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Fork lệch upstream (phát hành gần như hằng tuần; không gửi upstream) | Cao | Mã mới trong module riêng (`remote/v2/`, `src/remote/*`), ít điểm chạm `live.js`/`lib.rs`; merge upstream sau mỗi giai đoạn |
| Mở rộng quyền từ phone (tab chạy yolo + `manage`) | Cao | Scope theo thiết bị kiểm tra ở Rust, mặc định `view`; xác nhận + audit cho hành động phá huỷ; thu hồi tức thì; ACL Tailscale chỉ iPhone |
| `live.js` dễ gãy (254 KB, chuỗi `_handleResponse`, merge theo `ts`) | Cao | Method mới là lớp mỏng gọi logic thuần có test; tránh sửa `_handleResponse`; e2e bằng `omp-sim` |
| Updater đè bản fork / mất signing key | Cao | Đổi pubkey + endpoint commit đầu; key lưu hai nơi |
| Thiết kế trễ hoặc vượt khả năng plain JS | Trung bình | Handoff ghi rõ ràng buộc kỹ thuật; Giai đoạn 0–1 không chờ thiết kế |
| Chưa có toolchain Windows | Trung bình | Giai đoạn 0 + baseline test trước khi sửa |
| iOS PWA (WebSocket bị kill nền, storage riêng) | Trung bình | Push + nối lại/tải bù; ghép bằng QR trong app |
| Giới hạn frame/text | Trung bình | Chunk + cursor, không nâng giới hạn |
| omp nâng version floor | Thấp | Tăng `MIN_OMP_VERSION` cùng commit, không fallback |
| Mất cấu hình khi chuyển fork | Thấp | Giữ identifier, sao lưu, kiểm tra ở 1.7 |
