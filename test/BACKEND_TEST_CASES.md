# CareBill Backend/API Test Cases

**Scope:** Node.js/Express API, PostgreSQL persistence, authentication, role authorization, multi-hospital isolation and billing invariants.

Base URL example: `http://localhost:4000/api`

## A. Health, Registration and Authentication

| ID | Endpoint / Scenario | Expected result |
|---|---|---|
| BE-A01 | `GET /health` | 200 with `{ ok: true }`. |
| BE-A02 | `POST /auth/register-hospital` valid payload | 201; hospital and first ADMIN are created in one transaction. |
| BE-A03 | Register new hospital | Five default V1 billing items are created automatically for that hospital. |
| BE-A04 | Invalid registration email | 400 validation error. |
| BE-A05 | Password < 6 characters | 400 validation error. |
| BE-A06 | Duplicate email inside one firm | 409; transaction must not leave an orphan hospital. The same email may exist in another firm. |
| BE-A07 | Valid hospital-user mobile login | 200 with JWT and user/hospital metadata. |
| BE-A08 | Wrong password | Authentication rejected. |
| BE-A09 | Inactive user login | Rejected. |
| BE-A10 | Deleted user login | Rejected. |
| BE-A11 | Inactive hospital login | Rejected. |
| BE-A12 | Protected endpoint without token | 401. |
| BE-A13 | Protected endpoint with malformed token | 401. |
| BE-A14 | Token includes subject/hospital/role scope | Subsequent request resolves correct `req.user`. |
| BE-A15 | Platform Super Admin mobile login | 200 with Super Admin JWT and metadata. |
| BE-A16 | Login with an email address | 400 validation error; only mobile login is supported. |
| BE-A17 | Duplicate or invalid mobile identity | Login is rejected without revealing account existence. |
| BE-A18 | Valid mobile/password in two firms | Returns a five-minute selection token and only the password-validated firm choices; no full session token. |
| BE-A19 | `POST /auth/select-firm` with offered firm | Returns a session scoped to the selected firm. |
| BE-A20 | Select an unoffered/inactive firm or use an expired/invalid selection token | Rejected; no session is issued. |
| BE-A21 | Same mobile in multiple firms but different passwords | Only firms whose stored password matches are offered. |

## B. Users API

| ID | Endpoint / Scenario | Expected result |
|---|---|---|
| BE-B01 | ADMIN `GET /users` | 200 array containing current hospital admin and any other non-deleted users. |
| BE-B02 | DOCTOR `GET /users` | 403. |
| BE-B03 | RECEPTIONIST `GET /users` | 403. |
| BE-B04 | ADMIN `POST /users` valid doctor | 201 and doctor belongs to admin's hospital. |
| BE-B05 | ADMIN create receptionist | 201. |
| BE-B06 | ADMIN create admin | 201. |
| BE-B07 | Invalid role | 400. |
| BE-B08 | Duplicate email | 409. |
| BE-B09 | Short password | 400. |
| BE-B10 | `PATCH /users/:id/status` own-hospital user | Status toggles. |
| BE-B11 | Status change for other hospital user id | 404/not changed. |
| BE-B12 | `POST /users/:id/reset-password` valid | Password hash changes; new password works. |
| BE-B13 | Reset other-hospital user | 404/not changed. |
| BE-B14 | User list tenant filter | Hospital A token never receives Hospital B users. |
| BE-B15 | Create user without valid 10-digit mobile | 400. |
| BE-B16 | Create user with mobile already used inside that firm | 409; the same mobile remains valid in another firm. |
| BE-B17 | `PATCH /users/:id/mobile` firm-unique valid number | `users.mobile` updates and the new number is used for login. |
| BE-B18 | Update other-hospital user mobile | 404/not changed. |

## C. Billing Items API and Migration

| ID | Endpoint / Scenario | Expected result |
|---|---|---|
| BE-C01 | Apply `003_default_billing_items.sql` | Existing active hospitals receive missing default items. |
| BE-C02 | Re-run migration | Idempotent; no duplicate default items. |
| BE-C03 | Existing custom/default price conflict | Existing same-name row is preserved because migration uses `DO NOTHING`. |
| BE-C04 | `GET /billing-items` | Returns active items for current hospital only. |
| BE-C05 | `GET /billing-items?all=1` | Returns active and inactive non-deleted items for current hospital. |
| BE-C06 | ADMIN `POST /billing-items` | 201. |
| BE-C07 | DOCTOR/RECEPTION `POST /billing-items` | 403. |
| BE-C08 | Negative price | 400. |
| BE-C09 | Duplicate name in same hospital | 409. |
| BE-C10 | Same item name in another hospital | Allowed because uniqueness is hospital-scoped. |
| BE-C11 | ADMIN `PUT /billing-items/:id` | Name/price/status update succeeds for own hospital. |
| BE-C12 | Update other-hospital item | 404/not changed. |
| BE-C13 | Inactive item used as charge by ID | Rejected as invalid/inactive. |

## D. Patients API

| ID | Endpoint / Scenario | Expected result |
|---|---|---|
| BE-D01 | Search empty term | 200 empty array. |
| BE-D02 | Search by exact/partial mobile | Matching own-hospital patients returned. |
| BE-D03 | Search by partial name | Matching own-hospital patients returned. |
| BE-D04 | Cross-hospital search | Other hospital patients never returned. |
| BE-D05 | ADMIN/RECEPTION create patient | 201 with name, mobile, gender, DOB, address. |
| BE-D06 | DOCTOR create patient | 403. |
| BE-D07 | Invalid gender | 400. |
| BE-D08 | Invalid date | 400. |
| BE-D09 | Mobile too short | 400. |
| BE-D10 | Update own-hospital patient | 200 and fields persist. |
| BE-D11 | Update other-hospital patient | 404. |
| BE-D12 | Patient history own hospital | Returns patient plus visits. |
| BE-D13 | Patient history cross hospital | 404. |

## E. Visit Creation and Queue

| ID | Endpoint / Scenario | Expected result |
|---|---|---|
| BE-E01 | `GET /visits/doctors` | Only active non-deleted doctors in current hospital returned. |
| BE-E02 | ADMIN/RECEPTION `POST /visits` valid | 201 with `WAITING_FOR_DOCTOR`. |
| BE-E03 | DOCTOR create visit | 403. |
| BE-E04 | Invalid patient ID | 400. |
| BE-E05 | Invalid/inactive doctor ID | 400. |
| BE-E06 | Cross-hospital patient/doctor IDs | Rejected. |
| BE-E07 | ADMIN/RECEPTION `GET /visits` | Own-hospital visits only. |
| BE-E08 | DOCTOR `GET /visits` | Only visits assigned to that doctor. |
| BE-E09 | `GET /visits?status=PAYMENT_PENDING` | Correct status filter. |
| BE-E10 | Doctor starts own waiting visit | Status becomes `WITH_DOCTOR`. |
| BE-E11 | Doctor starts another doctor's visit | Rejected. |
| BE-E12 | Start non-waiting visit | Rejected. |

## F. Doctor Billing Invariants

| ID | Scenario | Expected result |
|---|---|---|
| BE-F01 | Doctor sends visit with one default charge | Charge source `DOCTOR`, price resolved from active billing item, `is_locked=TRUE`. |
| BE-F02 | Doctor sends multiple default charges | All charges stored and total equals sum. |
| BE-F03 | Doctor sends custom charge | Custom description/amount stored. |
| BE-F04 | Doctor sends with no charges | Visit becomes `PAYMENT_PENDING`; `doctor_billing_finalized=FALSE`. |
| BE-F05 | Doctor sends with charges | Visit becomes `PAYMENT_PENDING`; `doctor_billing_finalized=TRUE`. |
| BE-F06 | Doctor tries inactive billing item | Rejected. |
| BE-F07 | Doctor uses another hospital billing item ID | Rejected. |
| BE-F08 | Doctor completes another doctor's visit | 403. |
| BE-F09 | Doctor completes visit after charges already exist | Rejected; no duplicate doctor charges. |
| BE-F10 | Doctor direct pay without payment mode | 400. |
| BE-F11 | Doctor direct pay valid | Payment stored for exact server-calculated total; visit `COMPLETED`. |
| BE-F12 | Doctor direct pay with zero charges | Behaviour matches current scope: zero total payment may complete; verify business acceptance. |
| BE-F13 | Duplicate direct pay attempt | Rejected by status/unique payment constraint; only one payment remains. |

## G. Reception Charges and Locked Doctor Charges

| ID | Scenario | Expected result |
|---|---|---|
| BE-G01 | Reception adds default item during `PAYMENT_PENDING` | 201 with source `RECEPTION`, unlocked until payment. |
| BE-G02 | Reception adds custom item | 201. |
| BE-G03 | Add reception charge in wrong visit status | Rejected. |
| BE-G04 | Edit own-hospital unlocked reception charge | 200. |
| BE-G05 | Delete own-hospital unlocked reception charge | 204. |
| BE-G06 | Try to edit doctor charge through reception edit endpoint | Rejected. |
| BE-G07 | Try to delete doctor charge through reception delete endpoint | Rejected. |
| BE-G08 | Try to edit locked reception charge after payment | Rejected. |
| BE-G09 | Cross-hospital charge mutation | Rejected/no row changed. |

## H. Reception Payment

| ID | Scenario | Expected result |
|---|---|---|
| BE-H01 | Pay a `PAYMENT_PENDING` visit | Payment amount is computed by server from all charges. |
| BE-H02 | Doctor + reception charges | Payment equals combined sum. |
| BE-H03 | CASH/UPI/CARD/OTHER | Each accepted payment mode succeeds. |
| BE-H04 | Optional reference number | Saved when supplied. |
| BE-H05 | After payment | All visit charges are locked; visit status is `COMPLETED`; completion actor/time are set. |
| BE-H06 | Pay non-pending visit | Rejected. |
| BE-H07 | Duplicate payment | Rejected; unique `(hospital_id, visit_id)` ensures one payment. |
| BE-H08 | Cross-hospital pay attempt | 404/rejected. |

## I. Cancellation

| ID | Scenario | Expected result |
|---|---|---|
| BE-I01 | ADMIN/RECEPTION cancel waiting visit | Status `CANCELLED`, actor/time set. |
| BE-I02 | Cancel with-doctor visit | Allowed by current scope. |
| BE-I03 | Cancel payment-pending unpaid visit | Allowed by current scope. |
| BE-I04 | Cancel paid/completed visit | Rejected. |
| BE-I05 | DOCTOR cancel endpoint | 403. |

## J. Dashboard / Settings

| ID | Scenario | Expected result |
|---|---|---|
| BE-J01 | Dashboard ADMIN/RECEPTION | Today's hospital-wide counters returned. |
| BE-J02 | Dashboard DOCTOR | Counters and revenue scoped to doctor. |
| BE-J03 | Dashboard tenant isolation | No other hospital visits/revenue included. |
| BE-J04 | `GET /hospital` | Own hospital only. |
| BE-J05 | ADMIN `PUT /hospital` | Hospital name/mobile/address update succeeds. |
| BE-J06 | DOCTOR/RECEPTION update hospital | 403. |

## K. Database Integrity / Security

| ID | Scenario | Expected result |
|---|---|---|
| BE-K01 | Cross-tenant patient FK into visit | DB composite FK rejects invalid tenant combination. |
| BE-K02 | Cross-tenant doctor FK into visit | DB rejects. |
| BE-K03 | Cross-tenant billing item FK into charge | DB rejects. |
| BE-K04 | Cross-tenant user as charge creator | DB rejects. |
| BE-K05 | Negative billing amount | DB/API rejects. |
| BE-K06 | Invalid visit status | DB CHECK rejects. |
| BE-K07 | Invalid payment mode | DB/API rejects. |
| BE-K08 | Invalid role | DB/API rejects. |
| BE-K09 | Password storage | Database stores bcrypt hash, never plaintext password. |
| BE-K10 | SQL injection strings in search/name fields | Treated as values via parameterized queries; no query alteration. |
| BE-K11 | CORS | Only configured frontend origin is accepted by browser CORS policy. |
| BE-K12 | Large JSON body | Request beyond configured 1 MB limit is rejected. |

## L. Data Visibility Hotfix Regression

| ID | Scenario | Expected result |
|---|---|---|
| BE-L01 | Existing `Hospital1` after migration | `GET /billing-items?all=1` returns default items. |
| BE-L02 | Newly registered hospital after code hotfix | Default items created inside registration transaction. |
| BE-L03 | Users list for existing `Hospital1` | `GET /users` returns its admin and any added users. |
| BE-L04 | Wrong backend database URL | UI now exposes API/empty-state symptom; diagnose by comparing DB registrations and API results. |
| BE-L05 | Re-run migration after custom items exist | Custom items remain untouched. |
