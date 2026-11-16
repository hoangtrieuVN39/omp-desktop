# Design handoff — OMP Remote (mobile)

> Cho: UI/UX designer. Từ: chủ dự án. Ngày: 2026-11-16.
> Kế hoạch kỹ thuật: [`PLAN.md`](PLAN.md). Tài liệu này mô tả **cái gì cần thiết kế và ràng buộc nào là cố định**; cách thể hiện là quyền của designer.

## 1. Bối cảnh

**omp** (oh-my-pi) là coding agent chạy trên máy tính. **OMP Desktop** là app desktop cho omp: mỗi tab là một phiên agent làm việc trong một thư mục project. Desktop có sẵn **Remote access**: một web app (PWA) mở trên điện thoại qua Tailscale để xem và điều khiển các tab đó.

Web app hiện tại chỉ có **một màn chat**: header (tên tab + thư mục + chấm trạng thái), bottom sheet chọn tab, transcript, composer một ô nhập + một nút (Send / Steer / Stop). Dự án mở rộng nó thành app điều khiển **gần như đầy đủ** tính năng desktop.

**Mục tiêu thiết kế:** rời bàn làm việc mà vẫn theo dõi, ra lệnh, duyệt thay đổi của agent trên iPhone — nhanh, một tay, an toàn với hành động phá huỷ.

## 2. Người dùng và tình huống

- **Người dùng:** một developer (chủ máy), dùng thành thạo omp trên desktop. Không có người dùng thứ hai.
- **Thiết bị chính:** iPhone 12, iOS 18.7, dùng như **app trên Home Screen** (PWA, toàn màn hình). Safari tab chỉ là đường vào lần đầu.
- **Tình huống chính** (theo độ ưu tiên):
  1. Nhận push "Question waiting" → mở → trả lời câu hỏi/approval của agent → quay lại việc khác. *(< 15 giây)*
  2. Đang ngoài đường, xem tab nào đang chạy / xong / lỗi; đọc kết quả.
  3. Gửi prompt mới, steer khi agent đang chạy, dừng khi đi sai hướng.
  4. Duyệt diff agent vừa sửa, accept/reject file.
  5. Mở lại phiên cũ hoặc tạo phiên mới trong một project; đổi model.
  6. Theo dõi subagent đang chạy song song.
- **Môi trường:** mạng di động chậm/chập chờn (độ trễ 150–200 ms qua relay), thường dùng một tay, thời gian ngắn, có khi ngoài trời sáng.

## 3. Ràng buộc cố định (không thay đổi được)

### Nền tảng & kỹ thuật
| Ràng buộc | Hệ quả cho thiết kế |
|---|---|
| Web app chạy trong Safari/PWA trên iOS, **không phải app native** | Không có native tab bar/haptics/widgets iOS; push qua Web Push (chỉ khi mở từ Home Screen) |
| Plain JS + CSS, **không framework, không CDN**, CSP chặt (không inline script/style trong markup) | Tránh hiệu ứng cần thư viện animation nặng; icon phải là **SVG** đóng gói kèm (không icon font từ CDN); font: dùng font hệ thống hoặc file font có license để đóng gói |
| Kích thước tham chiếu | 390×844 pt (iPhone 12); kiểm tra thêm 375×667 (iPhone SE) và 430×932 (Pro Max). Dọc là chính; ngang chỉ cần không vỡ |
| Safe area (notch, home indicator), bàn phím iOS che nửa màn hình | Composer bám theo bàn phím; nút chính không nằm dưới home indicator |
| iOS có thể **kill kết nối khi app chạy nền** | Cần trạng thái "đang nối lại / đang tải bù" rõ ràng mỗi lần mở lại |
| Một tin nhắn gửi đi ≤ 32 KiB text; ảnh upload theo từng phần | Cần tiến trình upload ảnh, giới hạn số ảnh/kích thước (dev sẽ chốt số) |
| Thao tác gửi lên desktop có thể **chờ tối đa 15 giây** rồi hết hạn; tối đa 16 thao tác xếp hàng | Mỗi thao tác cần trạng thái *đang gửi → xong / lỗi*; không giả định thành công tức thì |
| Push **không chứa nội dung transcript** (chỉ "OMP · <tên tab>" + "Question waiting" / "Finished") | Màn hình đích khi chạm push phải tự giải thích ngữ cảnh |
| Ngôn ngữ giao diện: **tiếng Anh** (app có i18n theo chuỗi tiếng Anh) | Chừa ~30% độ dài cho bản dịch sau này; không chèn chữ vào ảnh |

### Ghép nối với desktop (quan trọng)
- **Tab trên phone = tab trên desktop.** Ở các bản đầu, chọn một tab trên phone **sẽ chuyển tab đang mở trên desktop** theo. Thiết kế cần cho người dùng biết điều này (ví dụ chỉ báo "Following on desktop") và không khuyến khích chuyển tab liên tục. Một bản sau có thể bỏ ràng buộc này — thiết kế nên không phụ thuộc vào nó.
- Desktop phải đang chạy; khi desktop tắt/ngủ, phone chỉ thấy "offline".

### Phân quyền thiết bị
Mỗi điện thoại đã ghép có một **scope** do chủ máy đặt trên desktop (không đổi được từ phone):

| Scope | Được làm | Ghi chú thiết kế |
|---|---|---|
| `view` (**mặc định** khi ghép mới) | Đọc mọi thứ, nhận push | Ẩn/khoá mọi nút hành động; banner/nhãn giải thích "View only — change on desktop" |
| `control` | + gửi prompt, steer, stop, trả lời câu hỏi, queue, gửi ảnh, steer/huỷ subagent, xuất HTML | |
| `manage` | + tạo/mở/đóng phiên, đổi tên, đổi profile của tab, branch/fork tại tin nhắn, mở nhánh trong tab mới, đổi model/goal, accept/reject file, đổi branch git, approval rules/mode | Hành động phá huỷ luôn cần xác nhận |

Thiết kế cần thể hiện **cả ba scope** cho các màn có hành động: nút bị khoá trông thế nào, chạm vào thì giải thích gì.

## 4. Phạm vi tính năng

**Trong phạm vi:** quản lý phiên · composer đầy đủ · transcript phong phú · subagent · review & git · approval · usage.
**Ngoài phạm vi (không thiết kế):** terminal, browser panel, voice/live conversation, trang Settings đầy đủ của desktop, duyệt widget plugin, đăng nhập provider (OAuth), thay đổi scope thiết bị.

## 5. Cấu trúc điều hướng đề xuất (designer được phép đề xuất khác, kèm lý do)

Bottom navigation 4 mục: **Sessions · Chat · Review · Agents**.
- Model, thinking, goal, plan mode: sheet mở từ composer.
- Ghép thiết bị, thông báo, thông tin kết nối/scope: một màn "Connection" mở từ header.
- Chạm push → mở thẳng đúng tab (và câu hỏi nếu có).

## 6. Danh sách màn hình

Mỗi màn: **mục đích · dữ liệu có sẵn · hành động (scope) · trạng thái cần vẽ**. Tên trường là dữ liệu thật dev có thể cấp; không cần hiển thị hết.

### 6.1 Connection & pairing
- **Mục đích:** lần đầu ghép phone với desktop; xem tình trạng kết nối; bật thông báo.
- **Dữ liệu:** trạng thái kết nối (connected / reconnecting / offline / revoked), tên thiết bị, scope hiện tại, tên host desktop, trạng thái push (on/off/không hỗ trợ).
- **Hành động:** "Pair with your desktop" (mở camera quét QR — QR hiện trên desktop, mã dùng một lần, hết hạn 5 phút); bật/tắt thông báo (iOS chỉ hỏi quyền sau một lần chạm của người dùng).
- **Trạng thái:** chưa ghép · đang quét · camera bị từ chối · QR không phải của desktop này · mã hết hạn/đã dùng · ghép xong · thiết bị bị thu hồi · đang mở trong Safari (khuyên "Add to Home Screen" để có push).

### 6.2 Sessions
- **Mục đích:** thấy toàn cảnh các tab và mở lại phiên cũ.
- **Hai khái niệm phải phân biệt rõ:**
  - **Open tab** = phiên đang sống trên desktop (có tiến trình agent). Dữ liệu: tiêu đề, tên thư mục project, `busy` (đang chạy), `hasAsk` (đang chờ trả lời), có tin chưa đọc, model.
  - **Saved session** = lịch sử đã lưu, chưa mở. Dữ liệu: tiêu đề, project, thời điểm cập nhật. Danh sách dài → phân trang/tìm kiếm.
- **Hành động:** mở tab (mọi scope); resume saved session, tạo phiên mới, đóng tab, đổi tên (`manage`). Đóng tab đang chạy → xác nhận.
- **Đổi profile của một tab đang mở** (`manage`): chọn profile khác trong danh sách (tên profile; profile = bộ đăng nhập/cài đặt/lịch sử riêng). Agent của tab **khởi động lại thành phiên mới, trống** trên profile đó; hội thoại cũ vẫn nằm trong lịch sử của profile cũ, không mang sang. → Bắt buộc xác nhận nói rõ điều này. Trạng thái: đang khởi động lại · lỗi (profile không tồn tại, omp không khởi động được).
- **Trạng thái:** không có tab nào · tab đang chạy / chờ câu hỏi / lỗi / xong · đang tải danh sách · mở thất bại.

### 6.3 New session (sheet hoặc màn)
- **Dữ liệu:** danh sách project (tên + id; **không nhập path tự do**), profile, model mặc định.
- **Hành động:** chọn project → (tuỳ chọn) chọn model/profile → tạo. Scope `manage`.
- **Trạng thái:** đang tạo · lỗi (ví dụ omp không khởi động được).

### 6.4 Chat (màn chính)
- **Header:** tên tab, thư mục, trạng thái chạy, chỉ báo "following on desktop", số tab khác đang chờ câu hỏi, chất lượng kết nối.
- **Transcript** gồm các loại khối:
  - Tin người dùng (có thể kèm ảnh); tin assistant (markdown: heading, list, bảng, code block có nút copy, link).
  - **Thinking** của model (thu gọn mặc định, mở được).
  - **Tool card** theo loại: `read` (file + dòng), `grep`, `bash` (lệnh + output), `eval` (ô code JS/Python + output), `edit` (diff), `write`, `task` (subagent), web search/fetch, `todo`; loại khác hiện output chung. Card hiện **tóm tắt**; chạm để xem output đầy đủ (tải theo yêu cầu, có thể dài hàng nghìn dòng).
  - Ghi chú hệ thống: compaction, retry tự động, request thất bại (có thông báo lỗi), lượt bị dừng.
  - **Câu hỏi của agent** (xem 6.6) nằm ngay trong luồng.
- **Composer:**
  - Ô nhập nhiều dòng (1 → ~5 dòng rồi cuộn); Return = xuống dòng.
  - Nút chính theo trạng thái: idle → **Send**; agent đang chạy + có nội dung → **Steer** (chèn vào lượt đang chạy); đang chạy + trống → **Stop**.
  - Thêm: **Queue follow-up** (gửi sau khi lượt hiện tại xong) — cần cách chọn Steer vs Queue khi agent đang chạy.
  - Hàng chờ (queue strip): các tin đã xếp hàng — đẩy lên đầu, xoá, gửi ngay.
  - Đính kèm ảnh (camera / thư viện) — chip ảnh trên ô nhập, tiến trình upload, xoá.
  - `/` mở **slash palette** (danh sách lệnh/skill của phiên, có mô tả + gợi ý tham số, lọc khi gõ).
  - `@` mở gợi ý **file trong project**.
  - Nút mở **sheet model/thinking/goal/plan** (6.5).
  - Thanh nhỏ: % context đã dùng, chi phí phiên.
- **Menu tin nhắn** (ví dụ giữ lâu trên tin; `manage` trừ Copy):
  - Tin **người dùng** → **Branch from here**: tạo nhánh mới ngay *trước* tin này; nội dung tin được đưa lại vào composer để sửa rồi gửi lại.
  - **Câu trả lời cuối của một lượt** → **Fork from here**: tạo nhánh mới tiếp tục *sau* câu trả lời này (không có gì để gửi lại).
  - Copy text (mọi scope).
  - Branch/fork chỉ làm được khi agent **đang rảnh**; tab giữ nguyên tên nhưng transcript tải lại theo nhánh mới, hội thoại cũ vẫn còn trong cây (6.12).
- **Menu phiên** (overflow ở header): **Conversation tree** (6.12), **Export HTML** (6.13), Rename, Switch profile, Compact, Close tab.
- **Hành vi cuộn:** mở tab hoặc gửi tin → nhảy xuống cuối; khi đang ở cuối, nội dung mới giữ ở cuối; cuộn lên thì giữ vị trí + nút "↓ Newest".
- **Trạng thái:** đang tải lịch sử · agent đang chạy (đang chờ phản hồi đầu tiên / đang chạy tool / đang compact / đang retry) · tin đang gửi / gửi lỗi (thử lại) · view-only · offline · desktop đổi sang tab khác · branch/fork bị khoá vì agent đang chạy · đang chuyển sang nhánh mới / chuyển thất bại.

### 6.5 Model / thinking / goal / plan (sheet)
- **Model:** danh sách gần đây (MRU) + toàn bộ theo provider, tìm kiếm; model hiện tại. Scope `manage`.
- **Thinking level:** các mức model hiện tại hỗ trợ, trong tập `off · minimal · low · medium · high · xhigh · max`.
- **Goal mode:** mục tiêu (text), token đã dùng/ngân sách, trạng thái; hành động bắt đầu, tạm dừng/tiếp tục, đặt ngân sách, bỏ.
- **Plan mode:** bật/tắt; khi agent trình plan → xem plan, gửi góp ý, approve.
- **Compact** phiên (giải phóng context) — xác nhận.

### 6.6 Câu hỏi & approval của agent (trong Chat + mở từ push)
Các dạng phải thiết kế:
| Dạng | Nội dung | Trả lời |
|---|---|---|
| `confirm` | câu hỏi có/không | Yes / No |
| `select` | danh sách lựa chọn | chọn 1 |
| `input` | câu hỏi + ô nhập 1 dòng | text |
| `editor` | câu hỏi + nội dung soạn sẵn nhiều dòng | text dài |
| `dialog` (tool `ask`) | **nhiều câu hỏi** một lúc, mỗi câu có lựa chọn, có thể chọn nhiều, có ô "câu trả lời khác", ghi chú | gửi một lần |
| Tool approval | agent xin chạy một tool (lệnh, file) | **Approve** · **Allow for this session** · **Always allow in this project** · Deny |
- Câu hỏi có thể bị **thu hồi** (agent huỷ, hoặc đã được trả lời trên desktop/thiết bị khác) → hiển thị "đã trả lời ở nơi khác".
- Nhiều tab có thể cùng chờ: cần lối tắt tới câu hỏi đang chờ ở tab khác.

### 6.7 Tool output / diff detail
- Output đầy đủ của một tool card: monospace, cuộn dài, tìm trong output, copy.
- Diff: thêm/xoá theo dòng, số dòng cũ/mới, nhảy giữa các thay đổi; xem được trên màn hẹp (gợi ý: unified, ngắt dòng hoặc cuộn ngang — designer chọn).

### 6.8 Review
- **Danh sách file thay đổi** của project tab hiện tại: path, trạng thái (modified / added / deleted / renamed / untracked), số dòng +/−.
- **Diff một file** (toàn file, thay đổi inline), nhảy giữa thay đổi.
- **Hành động** (`manage`): Accept (stage) / Reject (discard — **phá huỷ, bắt buộc xác nhận**) theo file; đổi branch (danh sách branch; bị khoá khi agent đang chạy).
- **Thẻ PR/CI** (nếu có): tiêu đề PR, +/−, trạng thái từng check.
- **Xem trước file** bất kỳ trong project (code tô màu, ảnh).
- **Trạng thái:** không có thay đổi · không phải git repo · đang tải · diff quá lớn (rút gọn) · thao tác git lỗi (hiện thông báo của git).

### 6.9 Agents (subagent)
- **Danh sách** subagent của tab: tên/vai trò, trạng thái (running / done / failed / cancelled), tiến độ, token, chi phí, thời gian; nhóm theo lệnh `task` đã tạo ra chúng.
- **Chi tiết:** nhiệm vụ được giao, transcript của subagent, output.
- **Hành động** (`control`): steer (nhắn cho subagent), huỷ (xác nhận).
- **Todo/plan** của tab: danh sách việc theo phase, trạng thái từng việc (có thể đặt ở Agents hoặc Chat — designer chọn).

### 6.10 Usage (phụ)
24 giờ gần nhất: số request, chi phí, token, tốc độ; theo model, theo project, theo loại agent. Chỉ đọc.

### 6.11 Approval rules (phụ, `manage`)
Danh sách rule "always allow" đã lưu theo project → thu hồi. Approval mode của project: **always ask / write / yolo** (đổi mode sẽ khởi động lại agent của tab đó khi rảnh — cần cảnh báo).

### 6.12 Conversation tree
- **Mục đích:** thấy các nhánh của hội thoại trong tab, chọn điểm để hỏi lại, mở một nhánh khác.
- **Dữ liệu:** mỗi **tin người dùng** là một hàng (cũ → mới), các nhánh nằm ở làn riêng như đồ thị git, vạch chia tại mỗi lần compaction; đánh dấu nhánh hiện tại và các đầu nhánh. Mỗi hàng có **trạng thái prompt cache** nếu hỏi lại từ đó: `warm` (còn > 10 phút) · `expiring` (≤ 10 phút) · `partial` · `cold` · `unknown` (provider không báo — không hiện màu/giá), kèm **giá ước tính** khi biết; nhãn "earlier process" nếu cache thuộc tiến trình agent cũ.
- **Hành động:** chọn một hàng → xem chi tiết (nội dung prompt, cache, giá) → **Branch from here** (như 6.4); chọn đầu một nhánh khác → **Open in new tab** (mở nhánh đó thành tab mới, bắt đầu cache nguội). Xem: `view`; hành động: `manage`. Làm mới cây.
- **Trạng thái:** đang dựng cây · cây chỉ có một nhánh · cây rất dài (hàng trăm prompt) · agent đang chạy (hành động bị khoá) · lỗi đọc lịch sử.
- Đồ thị nhiều làn trên màn hẹp là bài toán chính của màn này (xem câu hỏi mở 6).

### 6.13 Export HTML
- **Mục đích:** xuất toàn bộ phiên thành một file HTML và **tải về điện thoại**.
- **Hành động** (`control`): từ menu phiên → Export HTML.
- **Kết quả:** desktop ghi file, rồi điện thoại tải file về; khi xong, mở **share sheet của iOS** (Save to Files, AirDrop, gửi qua app khác…) hoặc xem trước file. File có thể lớn (vài MB) → cần thanh tiến trình tải và nút huỷ.
- **Trạng thái:** đang xuất trên desktop · đang tải về (tiến trình %) · tải xong → share/xem · huỷ · lỗi xuất · lỗi tải (thử lại) · file quá lớn (vượt giới hạn dev chốt).

## 7. Trạng thái chung (áp dụng mọi màn)
- Kết nối: connected · reconnecting (tự động) · offline (desktop tắt/ngủ hoặc mất mạng) · revoked (thiết bị bị thu hồi → về màn pairing).
- Thao tác: pending → success / failed (`desktop did not answer`, `expired`, `busy`, `not allowed`) — kèm cách thử lại.
- Scope: view / control / manage (mục 3).
- Rỗng, đang tải (skeleton), lỗi tải.
- Xác nhận cho hành động phá huỷ: đóng tab đang chạy, reject file, huỷ subagent, compact, đổi approval mode, đổi profile của tab.

## 8. Ngôn ngữ hình ảnh
- **Dùng lại hệ token của desktop** — trang phone đã nạp CSS desktop. Ba theme: **aurora** (tối, mặc định), **phosphor** (tối, kiểu terminal), **daylight** (sáng) + **màu accent** người dùng chọn; phone tự theo theme/accent của desktop.
- Token có sẵn (tên biến CSS): nền `--bg-app --bg-window --bg-surface --bg-elevated --bg-input --bg-hover --bg-active`; chữ `--fg --fg-2 … --fg-5`; viền `--line --line-soft --line-bright`; accent `--accent --accent-deep --accent-soft --accent-glow`; màu phụ `--amber --cyan --lilac --lime --magenta --rose`; diff `--diff-add-bg/fg --diff-rm-bg/fg`; syntax `--syntax-*`; bo góc `--r-1 (6) --r-2 (10) --r-3 (14) --r-pill`; font `--font-sans` (Geist/Inter/SF), `--font-mono` (JetBrains Mono/SF Mono).
- Thiết kế bằng **token ngữ nghĩa**, không mã màu rời. Nếu cần token mới (ví dụ màu trạng thái riêng cho mobile), liệt kê kèm giá trị cho cả 3 theme.
- Desktop hiện tối ưu chữ nhỏ (13px); trên phone thân chữ **≥ 16px**, monospace ≥ 13px.

## 9. Yêu cầu khả dụng & truy cập
- Vùng chạm ≥ 44×44 pt, cách nhau ≥ 8 pt; hành động chính trong vùng ngón cái (nửa dưới).
- Tương phản chữ ≥ 4.5:1 trên **cả 3 theme**; không truyền đạt trạng thái chỉ bằng màu (thêm icon/chữ).
- Hỗ trợ cỡ chữ hệ thống lớn (không cắt chữ ở 200%).
- `prefers-reduced-motion`: có phương án không animation.
- Nút chỉ có icon phải có nhãn truy cập (VoiceOver).
- Mọi sheet/modal có lối thoát (đóng/huỷ) rõ ràng; vuốt xuống để đóng sheet.

## 10. Sản phẩm cần giao
1. **Sơ đồ luồng** (IA + flow) cho 6 tình huống ở mục 2.
2. **Thiết kế hi-fi** mọi màn ở mục 6, khung 390×844, kèm biến thể 375×667 cho Chat và Review.
3. **Ma trận trạng thái**: mỗi màn × trạng thái ở mục 6–7 (bao gồm 3 scope).
4. **Theme:** aurora + daylight đầy đủ; phosphor cho Chat và Sessions (các màn còn lại dùng token nên tự suy ra).
5. **Thư viện component** gắn token: tool card (từng loại), câu hỏi (6 dạng), composer (mọi trạng thái), list row tab/session, diff, sheet, toast/banner, empty/skeleton.
6. **Spec tương tác:** cử chỉ (vuốt, giữ, kéo xuống), chuyển cảnh, thời lượng/easing, hành vi bàn phím, hành vi cuộn transcript.
7. **Copy deck tiếng Anh** cho mọi nhãn, thông báo lỗi, xác nhận.
8. **Prototype bấm được** cho 3 luồng: (a) push → trả lời câu hỏi; (b) gửi prompt → steer → stop; (c) review → reject file có xác nhận.
9. **Icon set SVG** (hoặc chỉ định bộ icon mã nguồn mở có license cho phép đóng gói).
10. File nguồn (Figma hoặc tương đương) có đặt tên layer/component nhất quán.

## 11. Tiêu chí nghiệm thu thiết kế
- [ ] Mọi màn mục 6 và mọi trạng thái mục 7 đều có thiết kế.
- [ ] Ba scope thể hiện rõ; không có nút hành động "trông bấm được" ở scope `view`.
- [ ] Mọi hành động phá huỷ có xác nhận; mọi thao tác có trạng thái pending/lỗi.
- [ ] Phân biệt rõ Open tab vs Saved session; chỉ báo "following on desktop" rõ ràng.
- [ ] Luồng push → trả lời câu hỏi ≤ 3 lần chạm sau khi mở app.
- [ ] Đạt các yêu cầu mục 9 trên cả aurora và daylight.
- [ ] Chỉ dùng token (hoặc token mới đã liệt kê đủ 3 theme); icon SVG; không phụ thuộc font/thư viện tải từ mạng.

## 12. Câu hỏi mở cho designer
1. Bottom nav 4 mục hay cách khác (ví dụ Sessions là màn gốc, Chat/Review/Agents là tab trong phiên)?
2. Steer vs Queue khi agent đang chạy: một nút có menu giữ-để-chọn, hay hai nút?
3. Diff trên màn hẹp: unified ngắt dòng hay cuộn ngang?
4. Todo/plan đặt ở Chat (thanh ghim) hay ở Agents?
5. Có cần chế độ "quick reply" (trả lời câu hỏi ngay trong màn danh sách Sessions) không?
6. Conversation tree trên màn 390 pt: giữ đồ thị nhiều làn (thu gọn), hay danh sách phẳng theo nhánh với nút chuyển nhánh?

## 13. Tham chiếu
- Web app phone hiện tại: mở `https://dmm.tail3c2935.ts.net:7470` trên iPhone đã ghép (chủ dự án demo được).
- Ảnh chụp và mô tả tính năng desktop: [README omp-desktop](https://github.com/apoc/omp-desktop#features).
- Mô tả kỹ thuật Remote access hiện tại: [`docs/architecture/remote-access.md`](https://github.com/apoc/omp-desktop/blob/master/docs/architecture/remote-access.md).
- Token thiết kế: `src/design/styles.css` trong repo omp-desktop.
