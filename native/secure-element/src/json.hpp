#pragma once
// A deliberately tiny JSON layer: enough to write canonical voucher payloads and
// to read the flat objects this tool exchanges with the TypeScript side.
// Strings and unsigned integers only; nested values are not needed here.
#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <variant>

namespace se::json {

using Value = std::variant<std::string, std::uint64_t, bool>;
using Object = std::map<std::string, Value>;  // std::map keeps keys sorted, which is the canonical order

/** Escape a string the way JSON.stringify does for the characters that matter. */
std::string quote(const std::string& s);

/** Compact serialisation with keys in sorted order and no whitespace, byte-compatible with the TypeScript canonicalJson. */
std::string serialize(const Object& obj);

/** Parse a flat JSON object. Throws std::runtime_error on anything it does not understand. */
Object parse(const std::string& text);

const std::string& get_string(const Object& obj, const std::string& key);
std::uint64_t get_uint(const Object& obj, const std::string& key);

}  // namespace se::json
