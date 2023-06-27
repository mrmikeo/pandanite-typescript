#include <napi.h>
#include "pufferfish.h"
#include <iostream>

typedef std::array<uint8_t, 32> SHA256Hash;
std::string PUFFERFISH(const char* buffer, size_t len);
SHA256Hash SHA256(const char* buffer, size_t len);
std::string hexEncode(const char* buffer, size_t len);
std::string SHA256toString(SHA256Hash h);

Napi::Value PufferFishWrapped(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Wrong arguments").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!info[1].IsNumber()) {
    Napi::TypeError::New(env, "Wrong arguments").ThrowAsJavaScriptException();
    return env.Null();
  }

  const char* buffer = info[0].As<Napi::Buffer<const char>>().Data();

  size_t len = info[1].As<Napi::Number>().Uint32Value();

  std::string returnValue = PUFFERFISH(buffer, len);

  return Napi::String::New(env, returnValue); 
}   

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
  exports.Set(
    "PUFFERFISH", Napi::Function::New(env, PufferFishWrapped)
  );

  return exports;
}

std::string PUFFERFISH(const char* buffer, size_t len) {

    char hash[PF_HASHSPACE];
    memset(hash, 0, PF_HASHSPACE);

    int ret = 0;
    if ((ret = pf_newhash((const void*) buffer, len, 0, 8, hash)) != 0) {
      std::string stringValue("PUFFERFISH failed to compute hash"); 
      std::cout << stringValue << std::endl;
    }

    std::string hashString = SHA256toString(SHA256(hash, PF_HASHSPACE));

    return hashString;
}

SHA256Hash SHA256(const char* buffer, size_t len) {
    std::array<uint8_t, 32> ret;
    SHA256_CTX sha256;
    SHA256_Init(&sha256);
    SHA256_Update(&sha256, buffer, len);
    SHA256_Final(ret.data(), &sha256);

    return ret;
}

std::string hexEncode(const char* buffer, size_t len) {
    static const char* const lut = "0123456789ABCDEF";
    std::string output;
    output.reserve(2 * len);
    for (size_t i = 0; i < len; ++i) {
        const unsigned char c = buffer[i];
        output.push_back(lut[c >> 4]);
        output.push_back(lut[c & 15]);
    }
    return output;
}

std::string SHA256toString(SHA256Hash h) {
    return hexEncode((const char*)h.data(), h.size());
}

NODE_API_MODULE(pufferfish, Init)