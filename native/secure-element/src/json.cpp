#include "json.hpp"

#include <cctype>
#include <cstdio>

namespace se::json {

std::string quote(const std::string& s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(char(c));
                }
        }
    }
    out += "\"";
    return out;
}

std::string serialize(const Object& obj) {
    std::string out = "{";
    bool first = true;
    for (const auto& [key, value] : obj) {
        if (!first) out += ",";
        first = false;
        out += quote(key);
        out += ":";
        if (const auto* s = std::get_if<std::string>(&value)) out += quote(*s);
        else if (const auto* n = std::get_if<std::uint64_t>(&value)) out += std::to_string(*n);
        else out += std::get<bool>(value) ? "true" : "false";
    }
    out += "}";
    return out;
}

namespace {

struct Parser {
    const std::string& text;
    std::size_t pos = 0;

    void skip() {
        while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) ++pos;
    }
    [[noreturn]] void fail(const char* what) { throw std::runtime_error(std::string("json: ") + what + " at " + std::to_string(pos)); }
    void expect(char c) {
        skip();
        if (pos >= text.size() || text[pos] != c) fail("unexpected character");
        ++pos;
    }
    std::string string() {
        expect('"');
        std::string out;
        while (pos < text.size()) {
            char c = text[pos++];
            if (c == '"') return out;
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            if (pos >= text.size()) fail("dangling escape");
            char e = text[pos++];
            switch (e) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case '/': out.push_back('/'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u': {
                    if (pos + 4 > text.size()) fail("short \\u escape");
                    unsigned code = std::stoul(text.substr(pos, 4), nullptr, 16);
                    pos += 4;
                    if (code > 0x7f) fail("non-ASCII \\u escapes are not supported");
                    out.push_back(char(code));
                    break;
                }
                default: fail("unknown escape");
            }
        }
        fail("unterminated string");
    }
    std::uint64_t number() {
        skip();
        std::size_t start = pos;
        while (pos < text.size() && std::isdigit(static_cast<unsigned char>(text[pos]))) ++pos;
        if (start == pos) fail("expected digits");
        return std::stoull(text.substr(start, pos - start));
    }
    Value value() {
        skip();
        if (pos >= text.size()) fail("unexpected end");
        char c = text[pos];
        if (c == '"') return string();
        if (std::isdigit(static_cast<unsigned char>(c))) return number();
        if (text.compare(pos, 4, "true") == 0) { pos += 4; return true; }
        if (text.compare(pos, 5, "false") == 0) { pos += 5; return false; }
        fail("unsupported value");
    }
    Object object() {
        Object out;
        expect('{');
        skip();
        if (pos < text.size() && text[pos] == '}') { ++pos; return out; }
        while (true) {
            std::string key = string();
            expect(':');
            out[key] = value();
            skip();
            if (pos >= text.size()) fail("unterminated object");
            if (text[pos] == ',') { ++pos; continue; }
            if (text[pos] == '}') { ++pos; return out; }
            fail("expected , or }");
        }
    }
};

}  // namespace

Object parse(const std::string& text) {
    Parser p{text};
    Object out = p.object();
    p.skip();
    if (p.pos != text.size()) p.fail("trailing data");
    return out;
}

const std::string& get_string(const Object& obj, const std::string& key) {
    auto it = obj.find(key);
    if (it == obj.end()) throw std::runtime_error("json: missing field " + key);
    const auto* s = std::get_if<std::string>(&it->second);
    if (!s) throw std::runtime_error("json: field " + key + " is not a string");
    return *s;
}

std::uint64_t get_uint(const Object& obj, const std::string& key) {
    auto it = obj.find(key);
    if (it == obj.end()) throw std::runtime_error("json: missing field " + key);
    const auto* n = std::get_if<std::uint64_t>(&it->second);
    if (!n) throw std::runtime_error("json: field " + key + " is not a number");
    return *n;
}

}  // namespace se::json
