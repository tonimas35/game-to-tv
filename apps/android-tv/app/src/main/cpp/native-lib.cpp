// JNI glue for nodejs-mobile (https://github.com/nodejs-mobile/nodejs-mobile),
// adapted from its documented Android sample (native-lib.cpp):
//  - copies the Java String[] into ONE contiguous buffer, as node::Start
//    expects argv to be (libuv rewrites the process title in place);
//  - redirects stdout/stderr to logcat (tag «g2t-node»);
//  - calls node::Start(argc, argv), which only returns when Node ends.
// Node can only be started once per process: NodeService runs in its own
// process (:node) and never calls this twice.
#include <jni.h>
#include <string>
#include <vector>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

#include "node.h"

namespace {

const char *TAG = "g2t-node";
int pipe_stdout[2];
int pipe_stderr[2];
pthread_t thread_stdout;
pthread_t thread_stderr;

void *pump(void *arg) {
    const int fd = *static_cast<int *>(arg);
    const int prio = (fd == pipe_stderr[0]) ? ANDROID_LOG_WARN : ANDROID_LOG_INFO;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;   // logcat adds its own line break
        buf[n] = 0;
        __android_log_write(prio, TAG, buf);
    }
    return nullptr;
}

int redirect_stdout_stderr() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    if (pipe(pipe_stdout) == -1 || pipe(pipe_stderr) == -1) return -1;
    dup2(pipe_stdout[1], STDOUT_FILENO);
    dup2(pipe_stderr[1], STDERR_FILENO);
    if (pthread_create(&thread_stdout, nullptr, pump, &pipe_stdout[0]) == -1) return -1;
    if (pthread_create(&thread_stderr, nullptr, pump, &pipe_stderr[0]) == -1) return -1;
    pthread_detach(thread_stdout);
    pthread_detach(thread_stderr);
    return 0;
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_io_gametotv_android_NodeJni_startNodeWithArguments(JNIEnv *env, jclass, jobjectArray arguments) {
    const jsize argc = env->GetArrayLength(arguments);
    std::vector<std::string> args;
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto js = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char *s = env->GetStringUTFChars(js, nullptr);
        args.emplace_back(s);
        env->ReleaseStringUTFChars(js, s);
        env->DeleteLocalRef(js);
        total += args.back().size() + 1;
    }
    // Contiguous memory, never freed: Node keeps pointers into it until the process ends
    char *buffer = static_cast<char *>(calloc(total, 1));
    char **argv = static_cast<char **>(calloc(argc + 1, sizeof(char *)));
    char *pos = buffer;
    for (jsize i = 0; i < argc; i++) {
        memcpy(pos, args[i].c_str(), args[i].size());
        argv[i] = pos;
        pos += args[i].size() + 1;
    }
    if (redirect_stdout_stderr() == -1) {
        __android_log_write(ANDROID_LOG_ERROR, TAG, "No se pudo redirigir stdout/stderr a logcat");
    }
    return jint(node::Start(argc, argv));
}
