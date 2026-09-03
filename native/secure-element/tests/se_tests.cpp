// Plain-assert tests, run by ctest. No framework so the build stays dependency-free.
#include <cstdio>
#include <cstdlib>
#include <string>

#include "../src/json.hpp"
#include "../src/se.hpp"
#include "../src/sha256.hpp"

static int failures = 0;
#define CHECK(cond)                                                                        \
    do {                                                                                   \
        if (!(cond)) {                                                                     \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);           \
            ++failures;                                                                    \
        }                                                                                  \
    } while (0)

static void test_sha256_vectors() {
    CHECK(se::sha256_hex(std::string("")) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    CHECK(se::sha256_hex(std::string("abc")) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // 56 bytes: exercises the "padding spills into a second block" path.
    CHECK(se::sha256_hex(std::string("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")) ==
          "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

static void test_canonical_json_is_sorted_and_compact() {
    se::Voucher v;
    v.id = "vch_1"; v.from = "bank-a:asha"; v.fromKey = "ab"; v.to = "bank-b:ravi";
    v.amount = 12345; v.counter = 7; v.prevHash = "00"; v.issuedAt = "2026-09-03T09:00:00.000Z";
    const std::string expected =
        "{\"amount\":12345,\"counter\":7,\"from\":\"bank-a:asha\",\"fromKey\":\"ab\",\"id\":\"vch_1\","
        "\"issuedAt\":\"2026-09-03T09:00:00.000Z\",\"prevHash\":\"00\",\"to\":\"bank-b:ravi\"}";
    CHECK(se::canonical_payload(v) == expected);
    CHECK(se::json::quote("a\"b\\c\n") == "\"a\\\"b\\\\c\\n\"");
    auto parsed = se::json::parse(" {\"x\": \"y\\\"z\", \"n\": 42, \"b\": true} ");
    CHECK(se::json::get_string(parsed, "x") == "y\"z");
    CHECK(se::json::get_uint(parsed, "n") == 42);
}

static void test_sign_verify_and_tamper() {
    auto se = se::SecureElement::create("bank-b:ravi", std::nullopt);
    se.fund(30000);
    auto v = se.create_voucher("bank-a:dealer", 10000, "2026-09-03T09:00:00.000Z");
    CHECK(v.counter == 1);
    CHECK(v.fromKey == se.public_key_hex());
    CHECK(v.prevHash == std::string(64, '0'));
    CHECK(se::verify_voucher(v));
    CHECK(se.balance() == 20000);
    CHECK(se.last_hash() == se::voucher_hash(v));

    auto tampered = v;
    tampered.amount = 20000;
    CHECK(!se::verify_voucher(tampered));
    auto rekeyed = v;
    rekeyed.fromKey = std::string(64, 'a');
    CHECK(!se::verify_voucher(rekeyed));

    auto v2 = se.create_voucher("bank-a:dealer", 5000, "2026-09-03T09:01:00.000Z");
    CHECK(v2.counter == 2);
    CHECK(v2.prevHash == se::voucher_hash(v));
    CHECK(se::verify_voucher(v2));

    // JSON round trip keeps the signature valid.
    auto back = se::voucher_from_json(se::voucher_json(v2));
    CHECK(se::verify_voucher(back));
    CHECK(back.signature == v2.signature);
}

static void test_refuses_overspend_and_bad_amounts() {
    auto se = se::SecureElement::create("bank-b:ravi", std::nullopt);
    se.fund(1000);
    bool threw = false;
    try { se.create_voucher("bank-a:dealer", 1050, "t"); } catch (const std::runtime_error&) { threw = true; }
    CHECK(threw);
    CHECK(se.counter() == 0);  // a refused voucher never burns a counter
    threw = false;
    try { se.create_voucher("bank-a:dealer", 75, "t"); } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw);
    threw = false;
    try { se.fund(0); } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw);
}

static void test_seed_enrolment_and_persistence() {
    const std::string seed = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    auto a = se::SecureElement::create("bank-a:asha", seed);
    auto b = se::SecureElement::create("bank-a:asha", seed);
    CHECK(a.public_key_hex() == b.public_key_hex());
    CHECK(a.public_key_hex().size() == 64);
    auto c = se::SecureElement::create("bank-a:asha", std::nullopt);
    CHECK(c.public_key_hex() != a.public_key_hex());

    const std::string path = "se_test_state.json";
    a.fund(500);
    a.create_voucher("bank-b:x", 100, "t");
    a.save(path);
    auto loaded = se::SecureElement::load(path);
    CHECK(loaded.public_key_hex() == a.public_key_hex());
    CHECK(loaded.balance() == 400);
    CHECK(loaded.counter() == 1);
    CHECK(loaded.last_hash() == a.last_hash());
    auto v = loaded.create_voucher("bank-b:x", 100, "t2");
    CHECK(v.counter == 2);
    CHECK(se::verify_voucher(v));
    std::remove(path.c_str());
}

int main() {
    test_sha256_vectors();
    test_canonical_json_is_sorted_and_compact();
    test_sign_verify_and_tamper();
    test_refuses_overspend_and_bad_amounts();
    test_seed_enrolment_and_persistence();
    if (failures) {
        std::fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("secure-element: all checks passed\n");
    return 0;
}
