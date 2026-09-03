# TweetNaCl (vendored)

`tweetnacl.c` and `tweetnacl.h` are the 20140427 release of TweetNaCl by Daniel J. Bernstein,
Bernard van Gastel, Wesley Janssen, Tanja Lange, Peter Schwabe and Sjaak Smetsers,
downloaded from https://tweetnacl.cr.yp.to/. TweetNaCl is public domain.

One function was added for this project: `crypto_sign_ed25519_tweet_seed_keypair`, which
derives an Ed25519 keypair from a caller-supplied 32-byte seed using exactly the construction
of `crypto_sign_keypair` minus the call to `randombytes`. It lets the sandbox enrol a device
with a key the bank already registered. `randombytes` itself is provided by `src/se.cpp`.
