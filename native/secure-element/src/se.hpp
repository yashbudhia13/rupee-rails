#pragma once
// The device side of offline e₹, written the way a secure element would hold it:
// the private key never leaves this module, the spend counter only goes up, and
// every voucher is signed over a canonical payload that the bank and the payee
// can verify independently. State is persisted to a small JSON file so the CLI
// can be driven from another process (see src/secure-element.ts).
#include <array>
#include <cstdint>
#include <optional>
#include <string>

namespace se {

constexpr std::uint64_t SMALLEST_UNIT = 50;  // paise

struct Voucher {
    std::string id;
    std::string from;
    std::string fromKey;
    std::string to;
    std::uint64_t amount = 0;
    std::uint64_t counter = 0;
    std::string prevHash;
    std::string issuedAt;
    std::string signature;
};

std::string to_hex(const std::uint8_t* data, std::size_t len);
bool from_hex(const std::string& hex, std::uint8_t* out, std::size_t len);

/** The bytes that get signed: every field except the signature, keys sorted, no whitespace. */
std::string canonical_payload(const Voucher& v);
std::string voucher_hash(const Voucher& v);
std::string voucher_json(const Voucher& v);
Voucher voucher_from_json(const std::string& text);
bool verify_voucher(const Voucher& v);

class SecureElement {
public:
    /** New device. With a seed, the keypair is derived from it (custodial enrolment); without, a fresh one is generated. */
    static SecureElement create(const std::string& walletId, const std::optional<std::string>& seedHex);
    static SecureElement load(const std::string& path);
    void save(const std::string& path) const;

    void fund(std::uint64_t amount);
    Voucher create_voucher(const std::string& to, std::uint64_t amount, const std::string& issuedAt);

    const std::string& wallet_id() const { return walletId_; }
    std::string public_key_hex() const;
    std::uint64_t balance() const { return balance_; }
    std::uint64_t counter() const { return counter_; }
    const std::string& last_hash() const { return lastHash_; }
    std::string state_json() const;

private:
    std::string walletId_;
    std::array<std::uint8_t, 32> seed_{};
    std::array<std::uint8_t, 32> pk_{};
    std::array<std::uint8_t, 64> sk_{};
    std::uint64_t balance_ = 0;
    std::uint64_t counter_ = 0;
    std::string lastHash_ = std::string(64, '0');

    void derive_keys();
};

}  // namespace se
