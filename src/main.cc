#include <napi.h>
#include "pufferfish.h"
#include <iostream>
using namespace std;
typedef std::array<uint8_t, 32> SHA256Hash;
typedef std::array<uint8_t, 64> SHA256Hash64;

std::string PUFFERFISH(const char* buffer, size_t len);
std::string hexEncode(const char* buffer, size_t len);
SHA256Hash stringToSHA256(string hex);
SHA256Hash64 stringToSHA25664(string hex);
std::vector<uint8_t> hexDecode(const string& hex);

Napi::Value PufferFishWrapped(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
    return env.Null();
  }

  //if (!info[0].IsBuffer()) {
  //  Napi::TypeError::New(env, "Wrong arguments").ThrowAsJavaScriptException();
  //  return env.Null();
  //}
  std::string strMytestString("test1");
  std::cout << strMytestString << std::endl;

  std::string str = info[0].ToString().Utf8Value();
  std::cout << str << std::endl;

  SHA256Hash64 bytes = stringToSHA25664(str);

  const char* buffer = (const char*)bytes.data();

  size_t len = bytes.size();
  std::cout << len << std::endl;

  std::cout << buffer << std::endl;


  std::string strMytestString5(PUFFERFISH(buffer, len)); 
  std::cout << strMytestString5 << std::endl;
  std::string returnValue2("test3"); 
  //Napi::Value returnValue = Napi::String::New(env, PUFFERFISH(buffer, 64));
  Napi::Value returnValue = Napi::String::New(env, returnValue2);

  
  return returnValue;
}   

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
  exports.Set(
    "PUFFERFISH", Napi::Function::New(env, PufferFishWrapped)
  );

  return exports;
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

std::vector<uint8_t> hexDecode(const string& hex) {
  vector<uint8_t> bytes;
  for (size_t i = 0; i < hex.length(); i += 2) {
    string byteString = hex.substr(i, 2);
    char byte = (char) strtol(byteString.c_str(), NULL, 16);
    bytes.push_back(byte);
  }
  return std::move(bytes);
}

SHA256Hash stringToSHA256(string hex) {
    vector<uint8_t> bytes = hexDecode(hex);
    SHA256Hash sha;
    std::move(bytes.begin(), bytes.begin()+sha.size(), sha.begin());
    return sha;
}

SHA256Hash64 stringToSHA25664(string hex) {
    vector<uint8_t> bytes = hexDecode(hex);
    SHA256Hash64 sha;
    std::move(bytes.begin(), bytes.begin()+sha.size(), sha.begin());
    return sha;
}

std::string PUFFERFISH(const char* buffer, size_t len) {
    char hash[PF_HASHSPACE];
    memset(hash, 0, PF_HASHSPACE);
    int ret = pf_newhash((const void*) buffer, len, 0, 8, hash);
    if (ret != 0) {
       //Logger::logStatus("PUFFERFISH failed to compute hash");
    }
    std::string hashstring = hash;
    return hashstring;
}


NODE_API_MODULE(pufferfish, Init)