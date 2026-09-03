#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace se {

/** SHA-256 (FIPS 180-4). Small, dependency-free, used for voucher hashes. */
std::string sha256_hex(const std::uint8_t* data, std::size_t len);
std::string sha256_hex(const std::string& data);

}  // namespace se
