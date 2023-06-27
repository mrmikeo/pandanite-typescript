#include <napi.h>
#include "pufferfish.h"
#include <iostream>


char* PUFFERFISH(const char* buffer, size_t len);

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

  char* returnValue = PUFFERFISH(buffer, len);

  return Napi::Buffer<char>::New(env, returnValue, PF_HASHSPACE);
}   

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
  exports.Set(
    "PUFFERFISH", Napi::Function::New(env, PufferFishWrapped)
  );

  return exports;
}

char* PUFFERFISH(const char* buffer, size_t len) {

    char hash[PF_HASHSPACE];
    memset(hash, 0, PF_HASHSPACE);

    std::string returnValue4("test4"); 
    std::cout << returnValue4 << std::endl;

    int ret = 0;
    if ((ret = pf_newhash((const void*) buffer, len, 0, 8, hash)) != 0) {
       //Logger::logStatus("PUFFERFISH failed to compute hash");
      std::string stringValue("PUFFERFISH failed to compute hash"); 
      std::cout << stringValue << std::endl;
    }

  std::string returnValue5("test5"); 
  std::cout << returnValue5 << std::endl;

  std::string returnValue6("pufferhash string"); 
  std::cout << returnValue6 << std::endl;
  std::cout << hash << std::endl;

    return hash;
}


NODE_API_MODULE(pufferfish, Init)