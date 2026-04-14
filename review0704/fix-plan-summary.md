# Tóm tắt các vấn đề bảo mật (Lỗi 1, 2, 3)

### 1. Lỗi `#1` (Critical) - Lộ Key trên Storage của Trình duyệt
- **Vấn đề:** Ứng dụng phát Delegate Key (`x-delegate-key`) dạng rõ từ server về client và lưu thẳng trong `localStorage` bằng JavaScript.
- **Tình trạng:** **Trade-off.** Chấp nhận rủi ro này để có trải nghiệm hybrid (không bắt user phải ký ví cho mỗi thao tác).

### 2. Lỗi `#2` (High) - Sidecar cấu hình mở toang (Không xác thực)
- **Vấn đề:** Ở file `sidecar-server.ts`, API Server được bind host ở chế độ public (`0.0.0.0`) và gắn middleware CORS `*` (ai ở mạng ngoài cũng có thể gọi được). Hacker có thể gọi trực tiếp vào port của sidecar qua mạng để ra lệnh sinh vector hoặc bypass backend.
- **Đề án Fix (Có thể tự triển khai bất cứ lúc nào):**
  - Đổi binding từ cục bộ `0.0.0.0` thành `"127.0.0.1"`.
  - Xóa bỏ block middleware xử lý CORS `*`.
  - Viết 1 Auth Middleware nhỏ yêu cầu cung cấp header `X-Sidecar-Secret` chứa secret key (thông qua đối chiếu với biến `.env`).

### 3. Lỗi `#3` (High/Medium) - Tắt xác thực Máy chủ SEAL
- **Vấn đề Threshold = 2 (Nhiều máy chủ):** Hiện tại trên Mainnet, Mysten Labs sở hữu giao thức chuẩn là máy chủ **Enoki**. Rất tiếc, **Enoki không có Object ID dùng chung công cộng miễn phí** để bạn có thể sao chép cứng vào mã nguồn. Bạn buộc phải đăng nhập vào hệ thống *Enoki Dashboard* với tài khoản Mysten/Sui của dự án bạn để đăng ký và lấy Object ID API cho phía mình.
- **Vấn đề bypass xác thực (Vẫn Fix được):** Dù dùng 1 máy (Threshold = 1) hay 2 máy thì file `sidecar-server.ts` và các script khác đang cấu hình `{ verifyKeyServers: false }`. Điều này khiến MemWal bỏ qua kiểm tra chứng nhận chữ ký của server (dễ bị giả mạo máy chủ).
- **Đề án Fix:**
  - Vào 4 file (`sidecar-server.ts`, `seal-encrypt.ts`, `seal-decrypt.ts`, `manual.ts`) và đổi thành `{ verifyKeyServers: true }`.
  - Vẫn tạm thời giữ Threshold = 1 (Máy chủ Overclock Open) nhằm giữ ứng dụng không bị chết, cho tới khi bạn có Enoki Object ID thứ 2.
