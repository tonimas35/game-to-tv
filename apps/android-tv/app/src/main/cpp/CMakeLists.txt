# Native part of «Juegos del Salón» for Android TV: a tiny JNI library
# (native-lib) that starts nodejs-mobile's libnode.so.
# libnode/ (headers and prebuilt libnode.so per ABI) is downloaded by CI
# (.github/workflows/android.yml) or by apps/android-tv/get-libnode.sh.
cmake_minimum_required(VERSION 3.18.1)
project(g2tnative CXX)

set(LIBNODE_DIR ${CMAKE_SOURCE_DIR}/../../../libnode)

add_library(native-lib SHARED native-lib.cpp)
target_include_directories(native-lib PRIVATE ${LIBNODE_DIR}/include/node)

# IMPORTED: the Android Gradle plugin packages it into the APK by itself
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
