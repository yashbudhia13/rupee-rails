// cbdc-se: command-line face of the secure element simulator.
//
//   cbdc-se init   --state <file> --wallet <id> [--seed <hex>]
//   cbdc-se fund   --state <file> --amount <paise>
//   cbdc-se create --state <file> --to <walletId> --amount <paise> --at <iso8601>
//   cbdc-se verify --voucher <json | @file>
//   cbdc-se state  --state <file>
//
// Output is one JSON object on stdout. Exit codes: 0 ok, 2 usage, 3 refused, 4 invalid voucher.
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>

#include "json.hpp"
#include "se.hpp"

namespace {

int usage() {
    std::cerr << "usage: cbdc-se <init|fund|create|verify|state> [--state f] [--wallet id] [--seed hex] "
                 "[--amount paise] [--to id] [--at iso] [--voucher json|@file]\n";
    return 2;
}

std::map<std::string, std::string> parse_args(int argc, char** argv) {
    std::map<std::string, std::string> out;
    for (int i = 2; i + 1 < argc; i += 2) {
        std::string key = argv[i];
        if (key.rfind("--", 0) != 0) throw std::invalid_argument("expected --option, got " + key);
        out[key.substr(2)] = argv[i + 1];
    }
    return out;
}

const std::string& need(const std::map<std::string, std::string>& args, const char* key) {
    auto it = args.find(key);
    if (it == args.end()) throw std::invalid_argument(std::string("missing --") + key);
    return it->second;
}

std::string read_arg_or_file(const std::string& value) {
    if (!value.empty() && value[0] == '@') {
        std::ifstream f(value.substr(1), std::ios::binary);
        if (!f) throw std::runtime_error("cannot read " + value.substr(1));
        std::stringstream buf;
        buf << f.rdbuf();
        return buf.str();
    }
    return value;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) return usage();
    const std::string cmd = argv[1];
    try {
        auto args = parse_args(argc, argv);

        if (cmd == "init") {
            std::optional<std::string> seed;
            if (auto it = args.find("seed"); it != args.end()) seed = it->second;
            auto se = se::SecureElement::create(need(args, "wallet"), seed);
            se.save(need(args, "state"));
            std::cout << se.state_json() << "\n";
            return 0;
        }
        if (cmd == "fund") {
            auto se = se::SecureElement::load(need(args, "state"));
            se.fund(std::stoull(need(args, "amount")));
            se.save(need(args, "state"));
            std::cout << se.state_json() << "\n";
            return 0;
        }
        if (cmd == "create") {
            auto se = se::SecureElement::load(need(args, "state"));
            se::Voucher v;
            try {
                v = se.create_voucher(need(args, "to"), std::stoull(need(args, "amount")), need(args, "at"));
            } catch (const std::runtime_error& e) {
                std::cout << "{\"error\":" << se::json::quote(e.what()) << "}\n";
                return 3;
            }
            se.save(need(args, "state"));
            std::cout << se::voucher_json(v) << "\n";
            return 0;
        }
        if (cmd == "verify") {
            auto v = se::voucher_from_json(read_arg_or_file(need(args, "voucher")));
            bool ok = se::verify_voucher(v);
            std::cout << "{\"ok\":" << (ok ? "true" : "false") << ",\"hash\":\"" << se::voucher_hash(v) << "\"}\n";
            return ok ? 0 : 4;
        }
        if (cmd == "state") {
            auto se = se::SecureElement::load(need(args, "state"));
            std::cout << se.state_json() << "\n";
            return 0;
        }
        return usage();
    } catch (const std::invalid_argument& e) {
        std::cerr << "cbdc-se: " << e.what() << "\n";
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "cbdc-se: " << e.what() << "\n";
        return 1;
    }
}
