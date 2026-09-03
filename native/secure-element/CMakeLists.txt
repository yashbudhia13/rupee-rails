cmake_minimum_required(VERSION 3.16)
project(cbdc_secure_element C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 99)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_library(tweetnacl STATIC third_party/tweetnacl/tweetnacl.c)
target_include_directories(tweetnacl PUBLIC third_party/tweetnacl)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(tweetnacl PRIVATE -Wno-unused-variable)
endif()

add_library(se STATIC src/se.cpp src/sha256.cpp src/json.cpp)
target_include_directories(se PUBLIC src)
target_link_libraries(se PUBLIC tweetnacl)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(se PRIVATE -Wall -Wextra)
endif()

add_executable(cbdc-se src/main.cpp)
target_link_libraries(cbdc-se PRIVATE se)

add_executable(se_tests tests/se_tests.cpp)
target_link_libraries(se_tests PRIVATE se)

# Self-contained binaries: with MinGW a dynamically linked libstdc++ can be
# shadowed by another libstdc++-6.dll on PATH and crash inside iostreams.
if(MINGW)
  target_link_options(cbdc-se PRIVATE -static)
  target_link_options(se_tests PRIVATE -static)
elseif(CMAKE_CXX_COMPILER_ID MATCHES "GNU")
  target_link_options(cbdc-se PRIVATE -static-libstdc++ -static-libgcc)
  target_link_options(se_tests PRIVATE -static-libstdc++ -static-libgcc)
endif()

enable_testing()
add_test(NAME secure_element COMMAND se_tests)
