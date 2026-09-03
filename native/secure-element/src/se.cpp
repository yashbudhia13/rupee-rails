#include "se.hpp"

#include <fstream>
#include <random>
#include <sstream>
#include <stdexcept>
#include <vector>

#include "json.hpp"
#include "sha256.hpp"

extern "C" {
#include "tweetnacl.h"
}

// TweetNaCl asks the host for randomness. A real secure element has a hardware
// RNG; this sandbox uses the C++ standard library's non-deterministic source.
extern "C" void randombytes(unsigned char* out, unsigned long long len) {
    static std::random_device rd;
    for (unsigned long long i = 0; i < len; ++i) out[i] = static_cast<unsigned char>(rd());
}

namespace se {

std::string to_hex(const std::uint8_t* data, std::size_t len) {
    static const char* hex = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (std::size_t i = 0; i < len; ++i) {
        out.push_back(hex[data[i] >> 4]);
        out.push_back(hex[data[i] & 0xf]);
    }
    return out;
}

bool from_hex(const std::string& hex, std::uint8_t* out, std::size_t len) {
    if (hex.size() != len * 2) return false;
    auto nibble = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (std::size_t i = 0; i < len; ++i) {
        int hi = nibble(hex[2 * i]), lo = nibble(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) return false;
        out[i] = static_cast<std::uint8_t>(hi << 4 | lo);
    }
    return true;
}

static void assert_paise(std::uint64_t amount) {
    if (amount == 0) throw std::invalid_argument("amount must be positive");
    if (amount % SMALLEST_UNIT != 0) throw std::invalid_argument("amount must be a multiple of 50 paise");
}

std::string canonical_payload(const Voucher& v) {
    json::Object o;
    o["id"] = v.id;
    o["from"] = v.from;
    o["fromKey"] = v.fromKey;
    o["to"] = v.to;
    o["amount"] = v.amount;
    o["counter"] = v.counter;
    o["prevHash"] = v.prevHash;
    o["issuedAt"] = v.issuedAt;
    return json::serialize(o);
}

std::string voucher_hash(const Voucher& v) { return sha256_hex(canonical_payload(v)); }

std::string voucher_json(const Voucher& v) {
    json::Object o;
    o["id"] = v.id;
    o["from"] = v.from;
    o["fromKey"] = v.fromKey;
    o["to"] = v.to;
    o["amount"] = v.amount;
    o["counter"] = v.counter;
    o["prevHash"] = v.prevHash;
    o["issuedAt"] = v.issuedAt;
    o["signature"] = v.signature;
    return json::serialize(o);
}

Voucher voucher_from_json(const std::string& text) {
    json::Object o = json::parse(text);
    Voucher v;
    v.id = json::get_string(o, "id");
    v.from = json::get_string(o, "from");
    v.fromKey = json::get_string(o, "fromKey");
    v.to = json::get_string(o, "to");
    v.amount = json::get_uint(o, "amount");
    v.counter = json::get_uint(o, "counter");
    v.prevHash = json::get_string(o, "prevHash");
    v.issuedAt = json::get_string(o, "issuedAt");
    v.signature = json::get_string(o, "signature");
    return v;
}

bool verify_voucher(const Voucher& v) {
    std::uint8_t pk[32];
    std::uint8_t sig[64];
    if (!from_hex(v.fromKey, pk, 32) || !from_hex(v.signature, sig, 64)) return false;
    const std::string msg = canonical_payload(v);
    std::vector<std::uint8_t> sm(64 + msg.size());
    std::copy(sig, sig + 64, sm.begin());
    std::copy(msg.begin(), msg.end(), sm.begin() + 64);
    std::vector<std::uint8_t> m(sm.size());
    unsigned long long mlen = 0;
    return crypto_sign_open(m.data(), &mlen, sm.data(), sm.size(), pk) == 0;
}

void SecureElement::derive_keys() { crypto_sign_seed_keypair(pk_.data(), sk_.data(), seed_.data()); }

SecureElement SecureElement::create(const std::string& walletId, const std::optional<std::string>& seedHex) {
    if (walletId.empty()) throw std::invalid_argument("walletId is required");
    SecureElement se;
    se.walletId_ = walletId;
    if (seedHex) {
        if (!from_hex(*seedHex, se.seed_.data(), 32)) throw std::invalid_argument("seed must be 32 bytes of hex");
    } else {
        randombytes(se.seed_.data(), 32);
    }
    se.derive_keys();
    return se;
}

std::string SecureElement::public_key_hex() const { return to_hex(pk_.data(), 32); }

void SecureElement::fund(std::uint64_t amount) {
    assert_paise(amount);
    balance_ += amount;
}

Voucher SecureElement::create_voucher(const std::string& to, std::uint64_t amount, const std::string& issuedAt) {
    assert_paise(amount);
    if (to.empty()) throw std::invalid_argument("payee is required");
    if (amount > balance_) throw std::runtime_error("insufficient offline balance");

    Voucher v;
    std::uint8_t rnd[8];
    randombytes(rnd, 8);
    v.id = "vch_" + to_hex(rnd, 8);
    v.from = walletId_;
    v.fromKey = public_key_hex();
    v.to = to;
    v.amount = amount;
    v.counter = counter_ + 1;
    v.prevHash = lastHash_;
    v.issuedAt = issuedAt;

    const std::string msg = canonical_payload(v);
    std::vector<std::uint8_t> sm(64 + msg.size());
    unsigned long long smlen = 0;
    crypto_sign(sm.data(), &smlen, reinterpret_cast<const std::uint8_t*>(msg.data()), msg.size(), sk_.data());
    v.signature = to_hex(sm.data(), 64);

    // Commit the counter and balance only after the signature exists: the
    // element never hands out two vouchers with the same counter.
    counter_ = v.counter;
    balance_ -= amount;
    lastHash_ = voucher_hash(v);
    return v;
}

std::string SecureElement::state_json() const {
    json::Object o;
    o["walletId"] = walletId_;
    o["publicKey"] = public_key_hex();
    o["balance"] = balance_;
    o["counter"] = counter_;
    o["lastHash"] = lastHash_;
    return json::serialize(o);
}

void SecureElement::save(const std::string& path) const {
    json::Object o;
    o["walletId"] = walletId_;
    o["seed"] = to_hex(seed_.data(), 32);
    o["balance"] = balance_;
    o["counter"] = counter_;
    o["lastHash"] = lastHash_;
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    if (!f) throw std::runtime_error("cannot write state file " + path);
    f << json::serialize(o) << "\n";
}

SecureElement SecureElement::load(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot read state file " + path);
    std::stringstream buf;
    buf << f.rdbuf();
    json::Object o = json::parse(buf.str());
    SecureElement se;
    se.walletId_ = json::get_string(o, "walletId");
    if (!from_hex(json::get_string(o, "seed"), se.seed_.data(), 32)) throw std::runtime_error("corrupt seed in state file");
    se.balance_ = json::get_uint(o, "balance");
    se.counter_ = json::get_uint(o, "counter");
    se.lastHash_ = json::get_string(o, "lastHash");
    se.derive_keys();
    return se;
}

}  // namespace se
