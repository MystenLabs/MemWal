# Quy trình Review Security Tasks (MEM-1)

Mục tiêu chính: Đảm bảo tất cả các sub-task thuộc issue [MEM-1](https://linear.app/commandoss/issue/MEM-1/security-remediate-top-security-findings-from-full-codebase-audit) được rà soát code kỹ lưỡng, đã merge hoặc sẽ merge đúng vào nhánh `sec/security_fix`, đồng thời cập nhật trạng thái rõ ràng.

---

## 🚦 Flow thực hiện chi tiết

Duyệt qua từng sub-task nằm trong issue MEM-1 và xử lý theo các bước sau:

### Bước 1: Kiểm tra trạng thái đã Review
- Hãy kiểm tra xem task đó đã được tôi để lại comment và tag name `@jnaulty` vào nhờ review hay chưa?
  *(**Lưu ý:** Điều kiện này chỉ áp dụng rà soát riêng lẻ đối với các task do **Henry** thực hiện).*
- 🟢 **Nếu ĐÚNG (đã comment & tag):** Bỏ qua task này, tiếp tục với sub-task tiếp theo.
- 🔴 **Nếu SAI (chưa làm):** Chuyển sang xử lý Bước 2.

### Bước 2: Kiểm tra trực tiếp trên nhánh `sec/security_fix`
- Tra cứu trong source code của nhánh `sec/security_fix` xem đã thực sự có đoạn code (fix) tương tự giải quyết vấn đề của task này chưa.
- 🟢 **Nếu ĐÃ CÓ code fix:**
  - Ghi nhận và cập nhật trạng thái đã hoàn thành của task này vào file `res.md` (nếu file chưa tồn tại thì tự động tạo mới).
  - Kết thúc task này, chuyển qua sub-task kế tiếp.
- 🔴 **Nếu CHƯA CÓ code fix:** Chuyển sang rà soát Pull Requests ở Bước 3.

### Bước 3: Rà soát Pull Request (PR)
- Tìm xem đã có PR nào được tạo ra trên GitHub để xử lý task này hay chưa?
- ⚪ **Nếu CHƯA có PR nào:** (Lỗ hổng của quy trình cũ) -> Cần report ngay vào `res.md` là task này chưa có ai làm / chưa có PR.
- 🟠 **Nếu ĐÃ CÓ PR nhưng trỏ sai nhánh Base (vd đang trỏ vào `main`):**
  - Bắt buộc phải đổi lại base branch của PR trỏ thẳng vào nhánh `sec/security_fix`.
  - Sau khi đổi nhánh trỏ xong, chuyển xuống Bước 4.
- 🟢 **Nếu ĐÃ CÓ PR trỏ chuẩn vào `sec/security_fix`:** Tiến hành review code (Bước 4).

### Bước 4: Review Code chi tiết trong PR
- Thực hiện xem xét các đoạn code thay đổi trong PR:
  - Code được thay đổi có đúng với logic giải quyết bug hay chưa?
  - ⚠️ **QUAN TRỌNG:** Phải kiểm tra sát sao số lượng files changes. Nhiều PR có thể đính kèm commit rác hoặc dính các thay đổi **bị dư thừa** không thuộc trách nhiệm của nhánh `sec/security_fix`. Hãy đảm bảo chặn những PR rác này để không làm bẩn nhánh fix lỗi bảo mật.
- Kết thúc việc review, cập nhật tất cả tình hình, notes (chờ sửa code, có vấn đề, v.v) của task đó vào file tổng kết `res.md`.

dùng linear mcp, gh cli nhé