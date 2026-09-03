# Glossary

Every term used in this repository and in conversations about CBDC, in plain language, with
a pointer to where it shows up in the code.

## Money and ledgers

**Ledger.** The record of who owns what. A bank's ledger is a list of accounts and balances.
The core ledger here (`src/ledger.ts`) is the central bank's record of every e₹ token.

**Account model vs UTXO model.** Two ways to keep a ledger.
- *Account model*: each user has a balance; a payment subtracts from one balance and adds to
  another. Simple, like a bank account. Ethereum works this way.
- *UTXO model* ("unspent transaction output"): there are no balances, only individual tokens
  (like coins and notes). Each token was created by one transaction and can be spent by
  exactly one later transaction. A payment consumes some tokens as *inputs* and creates new
  tokens as *outputs*; the outputs must add up to the inputs. Your "balance" is just the sum
  of the tokens you currently hold. Bitcoin works this way, and so does a cash-like CBDC,
  which is why this project uses it. Double-spending is then a precise question: was this
  token spent twice? See `CoreLedger.transfer`.

**Denomination.** The face value of a token: 50 paise, ₹1, ₹2, ₹5, ₹10, ₹20, ₹50, ₹100, ₹200,
₹500. e₹ tokens carry denominations like physical cash. A payment of ₹1,250 spends whichever
tokens cover it and re-denominates the outputs, including your change. See `src/money.ts`.

**Change.** When your inputs are worth more than the payment, the difference comes back to
you as new tokens. Same word as in a shop. See `outputsFor` in `src/bank.ts`.

**Mint / burn.** Creating new money out of nothing, and destroying it. Only the central bank
may do either. `CoreLedger.mint` and `CoreLedger.burn`, both requiring the RBI signature.

**Issue / redeem.** Moving money from the central bank to a commercial bank (issue) and back
(redeem). The bank does not get it for free: its *reserve account* at the central bank is
debited on issue and credited on redeem. `CoreLedger.issue`, `CoreLedger.redeem`.

**Reserve account.** The balance a commercial bank keeps at the central bank. Real-world
equivalent of the `reserves` map in the ledger.

**Two-tier model.** Tier 1 is the central bank, which creates and destroys money and runs
the core ledger. Tier 2 is banks and licensed wallet providers, which deal with the public:
onboarding, KYC, apps, customer support. RBI's e₹ follows this split. Here Tier 1 is
`CoreLedger`, Tier 2 is `BankTier`, and `CoreClient` is the wire between them.

**Pool wallet.** The bank's own stock of e₹, from which customer wallets are loaded. Registered
by `CoreLedger.registerBank`.

**Load / unload.** Turning money in your bank account into e₹ in your wallet, and back. The
bank moves tokens from its pool to you and debits your account. `BankTier.load`, `unload`.

**Conservation of money (invariant).** At every moment, the sum of all unspent tokens must
equal everything ever minted minus everything ever burned. If this ever fails, money was
created or lost by a bug. `CoreLedger.invariants` checks it; every test asserts it.

**Settlement / finality.** A payment is *settled* when the ledger has recorded it and it can
no longer be reversed. In this system a transfer is final the moment the core accepts it.

**Reconciliation.** Comparing two records that should agree (your books vs the bank's, the
bank's vs the central bank's) and explaining every difference. The audit trail and the
invariants exist to make that possible.

## Security and cryptography

**Public-key cryptography.** A key pair: a private key you keep, a public key you share.
Anything signed with the private key can be verified by anyone holding the public key.

**Ed25519.** A specific, fast, widely used signature algorithm (it is what SSH and Signal use).
Every wallet here has an Ed25519 key; every transfer and voucher is signed with it.
`src/crypto.ts`, and `native/secure-element` in C++.

**Signature.** A short value proving that the holder of a private key approved exactly this
message. Changing one byte of the message invalidates it. Tests in `test/ledger.test.ts`
show a foreign-signed or tampered transfer being rejected.

**Canonical JSON.** To sign or hash a message, both sides must produce the exact same bytes.
Canonical JSON means keys sorted, no whitespace, no undefined fields. `canonicalJson` in
TypeScript and `json::serialize` in C++ are byte-compatible, which the interop test proves.

**Hash (SHA-256).** A fixed-size fingerprint of any data. Change the data and the fingerprint
changes completely. Used for voucher hashes and the ledger's hash chain.

**Hash chain / tamper-evident log.** Each log entry includes the hash of the previous entry,
so editing any past entry breaks every hash after it. That is what makes the ledger
*tamper-evident*: you cannot rewrite history unnoticed. It is not a blockchain, because there
is one operator and no consensus between parties. `CoreLedger.verifyChain`.

**HMAC.** A hash computed with a shared secret, used to prove a message came from someone who
knows the secret. Payment providers sign webhooks with HMAC; the receiver recomputes it over
the raw request body and compares. Not used in this repo, but relevant to payment systems.

**Idempotency.** Doing the same request twice has the same effect as doing it once. Payment
systems retry constantly (network drops, timeouts), so every request carries an
*idempotency key*; a replay returns the original result instead of paying twice.
`CoreLedger.idempotent`.

**Custodial vs non-custodial.** Who holds the private key. Custodial: the bank holds it for
you (this sandbox). Non-custodial: your device holds it. The C++ secure element is how the
non-custodial version would work.

**Secure element.** A small tamper-resistant chip (in phones, SIMs, payment cards) that holds
keys and counters and refuses to give them up or roll them back. Offline CBDC designs put
the spend counter there so a device cannot be cloned or reset. `native/secure-element`
simulates one in software and is honest that software can be copied.

## Payments in India

**KYC (Know Your Customer).** Identity verification before opening an account. RBI allows
*minimum-KYC* wallets with lower limits and *full-KYC* wallets with higher ones.
`KYC_LIMITS` in `src/bank.ts`.

**P2P / P2M.** Person-to-person and person-to-merchant payments. `BankTier.payP2P`, `payQr`.

**UPI.** India's instant payment system. Merchants display a QR code that encodes a
`upi://pay?...` intent with the payee address, name, amount and category. An e₹ wallet that
can read those codes works everywhere UPI already works. `src/upi.ts`.

**VPA (Virtual Payment Address).** The `name@bank` style address in a UPI QR, mapped to a
wallet by the directory. `CoreLedger.lookupVpa`.

**MCC (Merchant Category Code).** A four-digit code for the type of business (5411 grocery,
0763 agricultural cooperative). Programmable money uses it to restrict where tokens can be
spent.

**DBT (Direct Benefit Transfer).** Government subsidies paid straight to beneficiaries.
Programmable e₹ lets the money be limited to its purpose. `BankTier.disburse`.

**Programmable money / purpose-bound money.** Tokens that carry conditions: which merchants,
until when, where. The ledger refuses spends that break the conditions. Once spent at a
qualifying merchant, the merchant holds ordinary money. `src/rules.ts`.

**Geofence.** A circle on the map; a spend must happen inside it. Distance is computed with
the haversine formula (great-circle distance on a sphere).

**Escrow.** Value set aside and held by a trusted party until conditions are met. Offline
prefunding parks tokens in the bank's escrow wallet so they can be paid out later against
vouchers. `BankTier.prefundOffline`.

**Voucher.** A signed promise to pay, created offline. Contains payer, payee, amount, a
counter and a link to the previous voucher. `src/offline.ts`.

**Monotonic counter.** A number that only ever goes up. Each voucher gets the next value. If
two vouchers share a counter, the device was cloned or rolled back: a double-spend.

**Double-spend.** Spending the same money twice. Online, the ledger prevents it (a token has
one spend). Offline, it can only be *detected* after the fact, when vouchers sync, unless
the counter lives in a secure element. `BankTier.syncVouchers` freezes the payer.

**Audit trail.** A record of every action: who, what, when, before and after, and whether it
succeeded. Regulators and auditors ask for it first. `BankTier.auditLog`.

## Engineering

**Property-based testing.** Instead of hand-written examples, the test generates thousands of
random scenarios and checks that a property (here: conservation holds, every double-spend is
caught) is true for all of them. `test/property.test.ts` with fast-check.

**Event sourcing / journal.** Storing the sequence of accepted operations rather than just
the current state, so the state can be rebuilt by replaying them. See `src/journal.ts`.

**Write-ahead logging.** Record the change durably before applying it, so a crash between the
two cannot lose an accepted operation.

**Serialised commit path.** Only one mutating operation runs at a time, so two concurrent
transfers cannot both pass validation against the same token.

**Chaincode.** Hyperledger Fabric's word for a smart contract: code that runs on the ledger
nodes and defines what transactions are valid. See `chaincode/`.

**Permissioned DLT.** A distributed ledger where only known, approved organisations run
nodes (banks and the central bank), as opposed to public chains anyone can join. Hyperledger
Fabric is the common choice; RBI's e₹ core is reported to be built on it.
