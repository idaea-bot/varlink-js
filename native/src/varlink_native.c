// varlink-js-native (DESIGN.md §4.15): unix-domain sockets that pass file descriptors (SCM_RIGHTS), peer
// credentials (SO_PEERCRED, SO_PEERPIDFD), the `user.varlink` xattr, plus small fd helpers. Node-API only
// (NAPI_VERSION 8) and libuv's uv_poll_t through napi_get_uv_event_loop. Linux is the supported platform; macOS
// builds for development (no pidfd, no xattr, no MSG_CMSG_CLOEXEC: FD_CLOEXEC is set right after recvmsg).
//
// Rules kept everywhere: every syscall result is checked; every fd we create or receive is close-on-exec; no
// SIGPIPE (MSG_NOSIGNAL, SO_NOSIGPIPE on macOS); EINTR is retried (except close(), which must not be retried); an
// fd is never touched after it was closed; errors become JS Errors with `code` (errno name), `errno` (negative, as
// Node reports it) and `syscall`.
#define NAPI_VERSION 8
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#include <uv.h>

#ifdef __linux__
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/xattr.h>
// Newer than the glibc/kernel headers of many build hosts; the values are the asm-generic ones
// (include/uapi/asm-generic/socket.h), used only on architectures that use that header.
#if defined(__x86_64__) || defined(__aarch64__) || defined(__i386__) || defined(__arm__) || defined(__riscv) || \
    defined(__loongarch__)
#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif
#ifndef SO_PASSRIGHTS
#define SO_PASSRIGHTS 83
#endif
#endif
#ifndef MFD_CLOEXEC
#define MFD_CLOEXEC 0x0001U
#endif
#ifndef MFD_ALLOW_SEALING
#define MFD_ALLOW_SEALING 0x0002U
#endif
#ifndef F_ADD_SEALS
#define F_ADD_SEALS 1033
#endif
#ifndef F_SEAL_SEAL
#define F_SEAL_SEAL 0x0001
#define F_SEAL_SHRINK 0x0002
#define F_SEAL_GROW 0x0004
#define F_SEAL_WRITE 0x0008
#endif
#endif

#ifdef __APPLE__
#include <sys/ucred.h>
#endif

/** The kernel's per-message fd limit (SCM_MAX_FD, include/net/scm.h; sd-varlink.c:3268 refuses more early). */
#define VN_SCM_MAX_FD 253
/** Bytes read per recvmsg. */
#define VN_READ_SIZE (64 * 1024)
/** First MSG_PEEK window of a bounded read (widened ×4 up to VN_READ_SIZE while no NUL is found). */
#define VN_PEEK_FIRST (4 * 1024)

// ---------------------------------------------------------------------------------------------------------------
// Errors

/** True if a napi call failed; a pending JS exception is left for the caller to propagate. */
#define VN_FAILED(call) ((call) != napi_ok)

/** Throws `message` as a plain Error (napi misuse, bad arguments). Returns NULL for convenience. */
static napi_value throw_plain(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
  return NULL;
}

/** An Error for errno `err` (positive) from `syscall`, Node style: code, errno (negative), syscall. */
static napi_value errno_error(napi_env env, int err, const char *syscall) {
  char name[64];
  char text[128];
  char message[256];
  uv_err_name_r(-err, name, sizeof name);
  uv_strerror_r(-err, text, sizeof text);
  snprintf(message, sizeof message, "%s %s: %s", syscall, name, text);
  napi_value code_v, msg_v, error, errno_v, syscall_v;
  if (VN_FAILED(napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &code_v))) return NULL;
  if (VN_FAILED(napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &msg_v))) return NULL;
  if (VN_FAILED(napi_create_error(env, code_v, msg_v, &error))) return NULL;
  if (VN_FAILED(napi_create_int32(env, -err, &errno_v))) return NULL;
  if (VN_FAILED(napi_set_named_property(env, error, "errno", errno_v))) return NULL;
  if (VN_FAILED(napi_create_string_utf8(env, syscall, NAPI_AUTO_LENGTH, &syscall_v))) return NULL;
  if (VN_FAILED(napi_set_named_property(env, error, "syscall", syscall_v))) return NULL;
  return error;
}

/** Throws errno_error(err, syscall). Returns NULL. */
static napi_value throw_errno(napi_env env, int err, const char *syscall) {
  napi_value error = errno_error(env, err, syscall);
  if (error != NULL) napi_throw(env, error);
  return NULL;
}

// ---------------------------------------------------------------------------------------------------------------
// fd helpers

/** close() without retrying EINTR (POSIX leaves the fd state unspecified; on Linux it is closed). */
static void close_quietly(int fd) {
  if (fd >= 0) (void)close(fd);
}

static void close_all(const int *fds, size_t n) {
  for (size_t i = 0; i < n; i++) close_quietly(fds[i]);
}

/** Sets FD_CLOEXEC. 0 or an errno. */
static int set_cloexec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0) return errno;
  if ((flags & FD_CLOEXEC) == 0 && fcntl(fd, F_SETFD, flags | FD_CLOEXEC) < 0) return errno;
  return 0;
}

/** Sets O_NONBLOCK. 0 or an errno. */
static int set_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0) return errno;
  if ((flags & O_NONBLOCK) == 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) return errno;
  return 0;
}

/** macOS has no MSG_NOSIGNAL: the socket option does the same. 0 or an errno. */
static int set_nosigpipe(int fd) {
#ifdef SO_NOSIGPIPE
  int one = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one) < 0) return errno;
#else
  (void)fd;
#endif
  return 0;
}

#ifdef MSG_NOSIGNAL
#define VN_MSG_NOSIGNAL MSG_NOSIGNAL
#else
#define VN_MSG_NOSIGNAL 0
#endif

#ifdef MSG_CMSG_CLOEXEC
#define VN_MSG_CMSG_CLOEXEC MSG_CMSG_CLOEXEC
#else
#define VN_MSG_CMSG_CLOEXEC 0
#endif

/** A duplicate of `fd` (≥ 3, close-on-exec). -1 with errno set on failure. */
static int dup_cloexec(int fd) {
  int r;
  do {
    r = fcntl(fd, F_DUPFD_CLOEXEC, 3);
  } while (r < 0 && errno == EINTR);
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Argument helpers

static int get_args(napi_env env, napi_callback_info info, size_t want, napi_value *argv, napi_value *self) {
  size_t argc = want;
  if (VN_FAILED(napi_get_cb_info(env, info, &argc, argv, self, NULL))) return -1;
  for (size_t i = argc; i < want; i++) napi_get_undefined(env, &argv[i]);
  return 0;
}

/**
 * A non-negative int32 from `v`; -1 (with an Error thrown) otherwise. `msg` names the argument ("fd must be a
 * non-negative integer").
 */
static int get_nonneg_int(napi_env env, napi_value v, const char *msg) {
  napi_valuetype t;
  if (VN_FAILED(napi_typeof(env, v, &t))) return -1;
  if (t != napi_number) {
    throw_plain(env, "ERR_INVALID_ARG_TYPE", msg);
    return -1;
  }
  double d;
  if (VN_FAILED(napi_get_value_double(env, v, &d))) return -1;
  if (!(d >= 0 && d <= 2147483647.0) || d != (double)(int32_t)d) {
    throw_plain(env, "ERR_INVALID_ARG_VALUE", msg);
    return -1;
  }
  return (int)d;
}

/** A non-negative int32 fd from `v`; -1 (with an Error thrown) otherwise. */
static int get_fd(napi_env env, napi_value v) { return get_nonneg_int(env, v, "fd must be a non-negative integer"); }

static napi_value make_int(napi_env env, int64_t n) {
  napi_value v;
  if (VN_FAILED(napi_create_int64(env, n, &v))) return NULL;
  return v;
}

static napi_value make_undefined(napi_env env) {
  napi_value v;
  napi_get_undefined(env, &v);
  return v;
}

static napi_value make_bool(napi_env env, bool b) {
  napi_value v;
  napi_get_boolean(env, b, &v);
  return v;
}

/** A UTF-8 copy of string argument `v` into a malloc'ed buffer (caller frees); NULL with a thrown error. */
static char *get_string(napi_env env, napi_value v, const char *what) {
  napi_valuetype t;
  if (VN_FAILED(napi_typeof(env, v, &t))) return NULL;
  if (t != napi_string) {
    char message[96];
    snprintf(message, sizeof message, "%s must be a string", what);
    throw_plain(env, "ERR_INVALID_ARG_TYPE", message);
    return NULL;
  }
  size_t len;
  if (VN_FAILED(napi_get_value_string_utf8(env, v, NULL, 0, &len))) return NULL;
  char *s = malloc(len + 1);
  if (s == NULL) {
    throw_errno(env, ENOMEM, "malloc");
    return NULL;
  }
  if (VN_FAILED(napi_get_value_string_utf8(env, v, s, len + 1, &len))) {
    free(s);
    return NULL;
  }
  if (strlen(s) != len) {
    free(s);
    char message[96];
    snprintf(message, sizeof message, "%s must not contain NUL", what);
    throw_plain(env, "ERR_INVALID_ARG_VALUE", message);
    return NULL;
  }
  return s;
}

/** The bytes of a TypedArray/Buffer argument (no copy). -1 with an Error thrown otherwise. */
static int get_bytes(napi_env env, napi_value v, const uint8_t **data, size_t *len) {
  bool is_typed;
  if (VN_FAILED(napi_is_typedarray(env, v, &is_typed))) return -1;
  if (!is_typed) {
    throw_plain(env, "ERR_INVALID_ARG_TYPE", "expected a Uint8Array");
    return -1;
  }
  napi_typedarray_type type;
  size_t length;
  void *ptr;
  if (VN_FAILED(napi_get_typedarray_info(env, v, &type, &length, &ptr, NULL, NULL))) return -1;
  if (type != napi_uint8_array && type != napi_uint8_clamped_array) {
    throw_plain(env, "ERR_INVALID_ARG_TYPE", "expected a Uint8Array");
    return -1;
  }
  *data = ptr;
  *len = length;
  return 0;
}

/**
 * fds from an optional array argument (undefined/null = none). At most VN_SCM_MAX_FD (more: ENOBUFS, like
 * sd_varlink_push_fd, sd-varlink.c:3268). Returns the count, or -1 with an error thrown.
 */
static int get_fd_array(napi_env env, napi_value v, int *out) {
  napi_valuetype t;
  if (VN_FAILED(napi_typeof(env, v, &t))) return -1;
  if (t == napi_undefined || t == napi_null) return 0;
  bool is_array;
  if (VN_FAILED(napi_is_array(env, v, &is_array))) return -1;
  if (!is_array) {
    throw_plain(env, "ERR_INVALID_ARG_TYPE", "fds must be an array of fd numbers");
    return -1;
  }
  uint32_t n;
  if (VN_FAILED(napi_get_array_length(env, v, &n))) return -1;
  if (n > VN_SCM_MAX_FD) {
    throw_errno(env, ENOBUFS, "sendmsg");
    return -1;
  }
  for (uint32_t i = 0; i < n; i++) {
    napi_value e;
    if (VN_FAILED(napi_get_element(env, v, i, &e))) return -1;
    int fd = get_fd(env, e);
    if (fd < 0) return -1;
    out[i] = fd;
  }
  return (int)n;
}

// ---------------------------------------------------------------------------------------------------------------
// The socket object

struct vn_instance;

typedef struct vn_socket {
  napi_env env;
  /** The environment's instance data (NULL once it was freed, at environment teardown). */
  struct vn_instance *inst;
  /** Links in the instance's list of live sockets (for the environment cleanup hook). */
  struct vn_socket *prev, *next;
  /** The JS wrapper: weak (count 0) while idle, strong (count 1) while the poll handle is active or closing. */
  napi_ref wrapper;
  bool strong;
  napi_async_context async_ctx;
  uv_poll_t poll;
  bool poll_initialized;
  /** uv_close was called on the poll handle; its callback frees nothing, it only drops the strong reference. */
  bool poll_closing;
  bool poll_closed;
  /** The JS wrapper was garbage-collected: the close callback frees the struct. */
  bool finalized;
  int fd;
  bool want_read;
  bool want_write;
  bool connecting;
  bool accept_fds;
  /**
   * SO_PASSRIGHTS as we last set it: -1 unknown (never set by us: the kernel default, or inherited from a listening
   * socket that strict mode set either way), else 0/1 (also recorded when the kernel has no such option).
   */
  int pass_rights;
  bool closed;
  bool unrefd;
  /** Capacity of the recvmsg control buffer, in fds (a test hook shrinks it to provoke MSG_CTRUNC). */
  int ctrl_fds;
} vn_socket;

/**
 * Per-environment data (one per Node environment: the main thread and each worker thread): the socket class, the
 * read buffer (each environment runs on its own thread, so the buffer must not be shared; the bytes are copied into
 * a Buffer at once), and the live sockets, which the environment cleanup hook closes before the loop goes away.
 */
/** A tracked fd and the identity of its file when tracked (checked again before the teardown closes it). */
typedef struct vn_tracked {
  int fd;
  dev_t dev;
  ino_t ino;
  /** st_mode & S_IFMT. */
  mode_t type;
  /** F_GETFL & O_ACCMODE. */
  int accmode;
  /** Linux: VN_ANON_* (see vn_classify). */
  uint8_t anon;
  /** VN_ANON_PIDFD: the `Pid:` of /proc/self/fdinfo/N when tracked. */
  long pid;
} vn_tracked;

/** Not on the anon inode (or not Linux). */
#define VN_ANON_NONE 0
/**
 * On the anon inode, `/proc/self/fd/N` → `anon_inode:[pidfd]`, with a `Pid:` > 0 (pidfds before Linux 6.9; peer
 * pidfds via SO_PEERPIDFD from 6.5). `Pid:` -1 (process gone) or 0 (another pid namespace) is VN_ANON_OTHER.
 */
#define VN_ANON_PIDFD 1
/** On the anon inode, anything else (eventfd, epoll, …) or unclassifiable (no /proc): never closed at teardown. */
#define VN_ANON_OTHER 2

/** Which fd type identified the anon inode (vn_instance.anon_probe). */
#define VN_PROBE_NONE 0
#define VN_PROBE_EVENTFD 1
#define VN_PROBE_EPOLL 2

/**
 * Tracked fds environment teardowns left open (gone, another file, or an anon-inode fd not identified), all envs.
 * unsigned long, not uint64_t: lock-free on 32-bit targets too (no libatomic).
 */
static unsigned long vn_teardown_skipped;

typedef struct vn_instance {
  napi_ref ctor;
  uint8_t *read_buffer;
  vn_socket *sockets;
  /** Set while the async cleanup hook waits for poll handles to close. */
  napi_async_cleanup_hook_handle cleanup;
  size_t closing;
  bool tearing_down;
  /**
   * fds this environment's JS holds on behalf of the library: received with messages, the library's duplicates
   * (dup(fd, true)) and pidfds (peerPidfd(true)). JS forgets one with close() (which closes it) or release() (when it
   * hands it to a user, who owns it from then on); whatever is left when the environment tears down (a worker
   * terminated mid-call) is closed by the cleanup hook, but only if it still looks like the same file (best effort,
   * see vn_same_file): a number closed behind the library's back and reused meanwhile (another thread) is left
   * alone when it can be told apart.
   */
  vn_tracked *fds;
  size_t n_fds, cap_fds;
  /**
   * Linux: the anon inode shared by eventfd/epoll/timerfd/signalfd/inotify (and pidfds before 6.9; peer pidfds
   * via SO_PEERPIDFD from 6.5), probed once with an eventfd, or an epoll fd if that fails (anon_probe: VN_PROBE_*; the
   * fallback helps when eventfd alone fails, not with EMFILE/ENFILE, which fail both).
   */
  bool anon_known;
  uint8_t anon_probe;
  dev_t anon_dev;
  ino_t anon_ino;
  /** Test counter: bounded reads that stopped at a NUL with more bytes queued behind it. */
  uint64_t bounded_cuts;
  /** Test counter: bounded reads whose peek window was widened (no NUL in the window before). */
  uint64_t peek_widenings;
  /** Test counter: SO_PASSRIGHTS setsockopt attempts of strict setAcceptFds calls (counted on every platform). */
  uint64_t pass_rights_calls;
} vn_instance;

static void vn_instance_free(napi_env env, void *data, void *hint) {
  (void)hint;
  vn_instance *inst = data;
  // Sockets finalized after this must not touch the instance any more.
  for (vn_socket *s = inst->sockets; s != NULL; s = s->next) s->inst = NULL;
  if (inst->ctor != NULL) napi_delete_reference(env, inst->ctor);
  free(inst->read_buffer);
  free(inst->fds);
  free(inst);
}

/** The identity vn_close_tracked compares: (st_dev, st_ino), file type, access mode. false if fstat/fcntl fail. */
static bool vn_identity(int fd, vn_tracked *out) {
  struct stat st;
  if (fstat(fd, &st) < 0) return false;
  int fl = fcntl(fd, F_GETFL);
  if (fl < 0) return false;
  *out = (vn_tracked){.fd = fd,
                      .dev = st.st_dev,
                      .ino = st.st_ino,
                      .type = st.st_mode & S_IFMT,
                      .accmode = fl & O_ACCMODE,
                      .anon = VN_ANON_NONE,
                      .pid = 0};
  return true;
}

#ifdef __linux__
/** Whether `/proc/self/fd/<fd>` reads `anon_inode:[pidfd]` (false without /proc). */
static bool vn_is_pidfd_link(int fd) {
  char path[48], link[64];
  snprintf(path, sizeof path, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(path, link, sizeof link - 1);
  if (n < 0) return false;
  link[n] = '\0';
  return strcmp(link, "anon_inode:[pidfd]") == 0;
}

/** The `Pid:` line of `/proc/self/fdinfo/<fd>` (a pidfd's process; -1 once it is gone). false if absent. */
static bool vn_fdinfo_pid(int fd, long *pid) {
  char path[48], buf[1024];
  snprintf(path, sizeof path, "/proc/self/fdinfo/%d", fd);
  int f;
  do f = open(path, O_RDONLY | O_CLOEXEC);
  while (f < 0 && errno == EINTR);
  if (f < 0) return false;
  size_t len = 0;
  for (;;) {
    ssize_t n = read(f, buf + len, sizeof buf - 1 - len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    len += (size_t)n;
    if (len == sizeof buf - 1) break;
  }
  close_quietly(f);
  buf[len] = '\0';
  const char *p = strncmp(buf, "Pid:", 4) == 0 ? buf : strstr(buf, "\nPid:");
  if (p == NULL) return false;
  p += (*p == '\n') ? 5 : 4;
  char *end;
  errno = 0;
  long v = strtol(p, &end, 10);
  if (end == p || errno != 0) return false;
  *pid = v;
  return true;
}

/**
 * Fills t->anon/t->pid for an fd on the anon inode: VN_ANON_PIDFD when /proc names it a pidfd and its fdinfo has a
 * `Pid:` > 0, else VN_ANON_OTHER (also when /proc is unavailable: then nothing on the anon inode is closed, as before;
 * and for `Pid:` -1, a process already gone, or 0, one outside our pid namespace: values shared by unrelated pidfds,
 * so they identify nothing).
 */
static void vn_classify(const vn_instance *inst, vn_tracked *t) {
  if (!inst->anon_known || t->dev != inst->anon_dev || t->ino != inst->anon_ino) return;
  long pid;
  if (vn_is_pidfd_link(t->fd) && vn_fdinfo_pid(t->fd, &pid) && pid > 0) {
    t->anon = VN_ANON_PIDFD;
    t->pid = pid;
  } else
    t->anon = VN_ANON_OTHER;
}
#endif

/**
 * Remembers `fd` as held by this environment's JS (see vn_instance.fds), with its file's identity. Best effort:
 * without memory (or if fstat fails) it is not tracked. An existing entry for the same number is stale (a number
 * cannot be open twice; it was closed behind the library's back and reused) and is overwritten.
 */
static void vn_track(vn_instance *inst, int fd) {
  if (inst == NULL || fd < 0) return;
  vn_tracked t;
  if (!vn_identity(fd, &t)) return;
#ifdef __linux__
  vn_classify(inst, &t);
#endif
  for (size_t i = 0; i < inst->n_fds; i++)
    if (inst->fds[i].fd == fd) {
      inst->fds[i] = t;
      return;
    }
  if (inst->n_fds == inst->cap_fds) {
    size_t cap = inst->cap_fds == 0 ? 16 : inst->cap_fds * 2;
    vn_tracked *grown = realloc(inst->fds, cap * sizeof *grown);
    if (grown == NULL) return;
    inst->fds = grown;
    inst->cap_fds = cap;
  }
  inst->fds[inst->n_fds++] = t;
}

/** Forgets `fd` (closed, or handed to a user). Returns whether it was tracked. */
static bool vn_untrack(vn_instance *inst, int fd) {
  if (inst == NULL) return false;
  // Linear: the list holds what JS has in flight (usually a few fds) and is bounded by RLIMIT_NOFILE.
  for (size_t i = inst->n_fds; i > 0; i--)
    if (inst->fds[i - 1].fd == fd) {
      inst->fds[i - 1] = inst->fds[--inst->n_fds];
      return true;
    }
  return false;
}

/**
 * Teardown: closes the tracked fds that still look like the file they were tracked with. Best effort: same
 * (st_dev, st_ino), file type and access mode; EBADF or any difference: left alone. What cannot be told apart: a
 * reused number that names the same inode (a dup of the tracked file, or another open of it with the same access
 * mode). On Linux an fd on the anon inode (eventfd, epoll, timerfd, signalfd, inotify, pidfds before 6.9 (peer pidfds
 * via SO_PEERPIDFD from 6.5): all one inode, so the identity says nothing) is closed only if it was tracked as a
 * pidfd (vn_classify: `Pid:` > 0) and /proc still names it a pidfd of the same `Pid:`; every other anon-inode fd is left open (libuv's loop fds of other threads are
 * of those kinds; a best-effort leak at teardown), as is a pidfd whose process has exited meanwhile (`Pid:` -1). Not
 * told apart: another pidfd of the same process on the reused number. Each fd left open counts in teardownSkipped.
 */
static void vn_close_tracked(vn_instance *inst) {
  for (size_t i = 0; i < inst->n_fds; i++) {
    const vn_tracked *t = &inst->fds[i];
    vn_tracked now;
    bool same = vn_identity(t->fd, &now) && now.dev == t->dev && now.ino == t->ino && now.type == t->type &&
                now.accmode == t->accmode;
#ifdef __linux__
    // Without the probe (eventfd and epoll_create1 failed at init, e.g. EMFILE/ENFILE, which the epoll fallback cannot
    // help with) anon fds cannot be recognized: leave every fd alone.
    if (same && !inst->anon_known) same = false;
    if (same && now.dev == inst->anon_dev && now.ino == inst->anon_ino) {
      long pid;
      same = t->anon == VN_ANON_PIDFD && vn_is_pidfd_link(t->fd) && vn_fdinfo_pid(t->fd, &pid) && pid == t->pid;
    }
#endif
    if (same)
      close_quietly(t->fd);
    else
      __atomic_add_fetch(&vn_teardown_skipped, 1, __ATOMIC_RELAXED);
  }
  inst->n_fds = 0;
}

/** The calling environment's instance data, or NULL. */
static vn_instance *vn_inst(napi_env env) {
  vn_instance *inst = NULL;
  if (napi_get_instance_data(env, (void **)&inst) != napi_ok) return NULL;
  return inst;
}

static void vn_link(vn_instance *inst, vn_socket *s) {
  s->inst = inst;
  s->prev = NULL;
  s->next = inst->sockets;
  if (inst->sockets != NULL) inst->sockets->prev = s;
  inst->sockets = s;
}

static void vn_unlink(vn_socket *s) {
  vn_instance *inst = s->inst;
  if (inst == NULL) return;
  if (s->prev != NULL)
    s->prev->next = s->next;
  else
    inst->sockets = s->next;
  if (s->next != NULL) s->next->prev = s->prev;
  s->prev = s->next = NULL;
  s->inst = NULL;
}

/** Frees a socket whose poll handle is closed (or never existed) and whose JS wrapper is gone. */
static void vn_free(vn_socket *s) {
  vn_unlink(s);
  free(s);
}

/** Control buffer for up to VN_SCM_MAX_FD fds, suitably aligned. */
typedef union {
  struct cmsghdr align;
  uint8_t buf[CMSG_SPACE(sizeof(int) * VN_SCM_MAX_FD)];
} vn_control;

static void vn_set_strong(vn_socket *s, bool strong) {
  if (s->strong == strong || s->wrapper == NULL) return;
  // Environment teardown: references are being dropped wholesale, leave them alone.
  if (s->inst != NULL && s->inst->tearing_down) return;
  uint32_t count;
  if (strong) {
    if (napi_reference_ref(s->env, s->wrapper, &count) == napi_ok) s->strong = true;
  } else {
    if (napi_reference_unref(s->env, s->wrapper, &count) == napi_ok) s->strong = false;
  }
}

static void vn_on_poll(uv_poll_t *handle, int status, int events);

/** Starts or stops the poll handle to match want_read/want_write/connecting (and the strong reference with it). */
static int vn_update_poll(vn_socket *s) {
  if (s->closed || !s->poll_initialized) return 0;
  int events = 0;
  if (s->want_read) events |= UV_READABLE;
  if (s->want_write || s->connecting) events |= UV_WRITABLE;
  if (events == 0) {
    int r = uv_poll_stop(&s->poll);
    vn_set_strong(s, false);
    return r;
  }
  vn_set_strong(s, true);
  return uv_poll_start(&s->poll, events, vn_on_poll);
}

static void vn_after_poll_close(uv_handle_t *handle) {
  vn_socket *s = handle->data;
  s->poll_closed = true;
  vn_instance *inst = s->inst;
  if (inst != NULL && inst->cleanup != NULL && inst->closing > 0 && --inst->closing == 0) {
    // The last handle the cleanup hook waited for: the environment may go on tearing down.
    napi_async_cleanup_hook_handle h = inst->cleanup;
    inst->cleanup = NULL;
    napi_remove_async_cleanup_hook(h);
  }
  if (s->finalized) {
    vn_free(s);
    return;
  }
  vn_set_strong(s, false);
}

/**
 * Environment teardown (worker termination, main environment exit): closes every live socket, so no poll handle is
 * left on a loop that is about to be closed, and tells Node it is done once libuv ran the close callbacks.
 */
static void vn_cleanup_hook(napi_async_cleanup_hook_handle handle, void *arg) {
  vn_instance *inst = arg;
  inst->tearing_down = true;
  inst->cleanup = handle;
  inst->closing = 0;
  for (vn_socket *s = inst->sockets; s != NULL; s = s->next) {
    if (!s->closed) {
      s->closed = true;
      s->want_read = s->want_write = s->connecting = false;
      if (s->poll_initialized && !s->poll_closing) {
        s->poll_closing = true;
        uv_close((uv_handle_t *)&s->poll, vn_after_poll_close);
      }
      close_quietly(s->fd);
      s->fd = -1;
    }
    if (s->poll_initialized && !s->poll_closed) inst->closing++;
  }
  // fds JS still held for the library (queued in a framer, ctx.fds of an unfinished call, a fetched pidfd): the
  // environment's JS will never close them now. fds handed to users were released and are not in the list; one that
  // was closed behind the library's back and whose number was reused (another thread) fails the identity check.
  vn_close_tracked(inst);
  if (inst->closing == 0) {
    inst->cleanup = NULL;
    napi_remove_async_cleanup_hook(handle);
  }
}

/** Closes the poll handle and the fd (idempotent). The fd is closed right after uv_close stopped watching it. */
static void vn_close(vn_socket *s) {
  if (s->closed) return;
  s->closed = true;
  s->want_read = s->want_write = s->connecting = false;
  if (s->poll_initialized && !s->poll_closing) {
    s->poll_closing = true;
    // Strong until the close callback ran: the handle lives inside the struct the wrapper owns.
    vn_set_strong(s, true);
    uv_close((uv_handle_t *)&s->poll, vn_after_poll_close);
  }
  close_quietly(s->fd);
  s->fd = -1;
}

static void vn_finalize(napi_env env, void *data, void *hint) {
  (void)hint;
  vn_socket *s = data;
  if (s->async_ctx != NULL) napi_async_destroy(env, s->async_ctx);
  s->async_ctx = NULL;
  if (s->wrapper != NULL) napi_delete_reference(env, s->wrapper);
  s->wrapper = NULL;
  s->finalized = true;
  // Only reachable while weak, i.e. not polling (or at environment teardown, after the cleanup hook closed it):
  // closing now is safe; the struct is freed once libuv is done.
  vn_close(s);
  if (!s->poll_initialized || s->poll_closed) vn_free(s);
}

/** Calls `wrapper[name](...argv)` through napi_make_callback (so microtasks run); a throw becomes uncaught. */
static void vn_emit(vn_socket *s, const char *name, size_t argc, napi_value *argv) {
  napi_env env = s->env;
  napi_value self, fn, result;
  napi_valuetype t;
  // An argument that could not be built (errno_error under memory pressure) is passed as undefined, not NULL.
  for (size_t i = 0; i < argc; i++)
    if (argv[i] == NULL) argv[i] = make_undefined(env);
  if (s->wrapper == NULL || napi_get_reference_value(env, s->wrapper, &self) != napi_ok || self == NULL) return;
  if (napi_get_named_property(env, self, name, &fn) != napi_ok) goto check_exception;
  if (napi_typeof(env, fn, &t) != napi_ok || t != napi_function) return;
  if (napi_make_callback(env, s->async_ctx, self, fn, argc, argv, &result) == napi_ok) return;
check_exception:;
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    napi_value exception;
    if (napi_get_and_clear_last_exception(env, &exception) == napi_ok) napi_fatal_exception(env, exception);
  }
}

/** A JS array of `n` fd numbers. */
static napi_value fd_array_value(napi_env env, const int *fds, size_t n) {
  napi_value arr;
  if (napi_create_array_with_length(env, n, &arr) != napi_ok) return NULL;
  for (size_t i = 0; i < n; i++) {
    napi_value v;
    if (napi_create_int32(env, fds[i], &v) != napi_ok || napi_set_element(env, arr, (uint32_t)i, v) != napi_ok)
      return NULL;
  }
  return arr;
}

/** Collects the SCM_RIGHTS fds of a received message (all of them closed if they do not fit). Returns the count. */
static size_t collect_fds(struct msghdr *mh, int *fds, size_t cap) {
  size_t n = 0;
  // No control buffer (ctrl_fds == 0): nothing to collect, and no NULL + 0 pointer arithmetic below.
  if (mh->msg_control == NULL) return 0;
  const uint8_t *end = (const uint8_t *)mh->msg_control + mh->msg_controllen;
  for (struct cmsghdr *c = CMSG_FIRSTHDR(mh); c != NULL; c = CMSG_NXTHDR(mh, c)) {
    // A header shorter than CMSG_LEN(0) is malformed: ignore it, and stop (CMSG_NXTHDR could not step past it).
    if (c->cmsg_len < CMSG_LEN(0)) break;
    if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS) continue;
    const uint8_t *data = CMSG_DATA(c);
    size_t k = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
    // Never read past the control buffer, whatever cmsg_len says (e.g. not shrunk on truncation).
    size_t room = data < end ? (size_t)(end - data) / sizeof(int) : 0;
    if (k > room) k = room;
    for (size_t i = 0; i < k; i++) {
      int fd;
      memcpy(&fd, data + i * sizeof(int), sizeof fd);
      if (n < cap)
        fds[n++] = fd;
      else
        close_quietly(fd);
    }
  }
  return n;
}

/**
 * How much to read while fds may arrive: up to and including the next NUL of what is queued (MSG_PEEK), so one
 * recvmsg never returns a message's tail together with the start of a later send that carries fds (the kernel would
 * attach those fds to the combined bytes). Copied from json_stream_peek_message_boundary (json-stream.c:1187-1227,
 * used at 1282; the reason is spelled out at 1049-1051). 0 = EAGAIN (nothing queued); `size` on EOF or an error, for
 * the real read to report.
 */
static size_t vn_peek_boundary(vn_socket *s, uint8_t *buf, size_t size) {
  // A small window first (most messages are small), widened ×4 up to the buffer only while no NUL is in sight, so a
  // stream of small messages does not copy 64 KiB per peek.
  size_t window = size < VN_PEEK_FIRST ? size : VN_PEEK_FIRST;
  for (;;) {
    ssize_t peeked;
    do {
      peeked = recv(s->fd, buf, window, MSG_PEEK | MSG_DONTWAIT);
    } while (peeked < 0 && errno == EINTR);
    if (peeked < 0) return errno == EAGAIN || errno == EWOULDBLOCK ? 0 : size;
    if (peeked == 0) return size;
    uint8_t *nul = memchr(buf, 0, (size_t)peeked);
    if (nul != NULL) {
      size_t bound = (size_t)(nul - buf) + 1;
      if (bound < (size_t)peeked && s->inst != NULL) s->inst->bounded_cuts++;
      return bound;
    }
    // Fewer bytes than the window: either that is all there is for now (the rest of the message has not arrived), or
    // MSG_PEEK stopped early at an skb boundary: after an skb carrying fds (SCM_RIGHTS), or before one with other
    // credentials than the bytes before it (Linux unix_stream_read_generic). Either way the bytes peeked hold no NUL,
    // so they all belong to the message being read, and a recvmsg of exactly them cannot reach a later send's fds:
    // the bound is still correct, and the next read goes on after them.
    if ((size_t)peeked < window || window == size) return (size_t)peeked;
    window = window * 4 < size ? window * 4 : size;
    if (s->inst != NULL) s->inst->peek_widenings++;
  }
}

/**
 * One recvmsg, delivered as `onread(error, bytes, fds, truncated)`: `bytes` null at EOF; `fds` (an array) only while
 * fd input is accepted, the read then bounded at the next NUL (vn_peek_boundary). With input off, fds that arrive are
 * closed at once and nothing is reported: the message goes on without them, as sd-varlink reads with plain recv()
 * then and the kernel discards them (json-stream.c:1318-1321). We keep a control buffer anyway, because macOS leaves
 * fds that do not fit installed and unreported. MSG_CTRUNC (e.g. an LSM refused some fds): the fds received are
 * closed, the bytes delivered, `truncated` set, like json-stream.c:1308-1317 (log, drop, continue). Returns false on
 * EAGAIN (keep waiting).
 */
static bool vn_do_read(vn_socket *s) {
  napi_env env = s->env;
  if (s->inst == NULL) {
    // Environment teardown: nothing will read any more.
    s->want_read = false;
    return true;
  }
  uint8_t *buffer = s->inst->read_buffer;
  size_t size = VN_READ_SIZE;
  if (s->accept_fds) {
    size = vn_peek_boundary(s, buffer, size);
    if (size == 0) return false;
  }
  vn_control control;
  struct iovec iov = {.iov_base = buffer, .iov_len = size};
  struct msghdr mh;
  memset(&mh, 0, sizeof mh);
  mh.msg_iov = &iov;
  mh.msg_iovlen = 1;
  if (s->ctrl_fds > 0) {
    mh.msg_control = control.buf;
    mh.msg_controllen = CMSG_SPACE(sizeof(int) * (size_t)s->ctrl_fds);
  }
  ssize_t n;
  do {
    n = recvmsg(s->fd, &mh, MSG_DONTWAIT | VN_MSG_CMSG_CLOEXEC);
  } while (n < 0 && errno == EINTR);
  int err = n < 0 ? errno : 0;
  if (n < 0 && (err == EAGAIN || err == EWOULDBLOCK)) return false;

  // Everything about the fds is settled before any napi call, so no failure below can leak one.
  int fds[VN_SCM_MAX_FD];
  size_t nfds = 0;
  bool truncated = false;
  if (n >= 0) {
    nfds = collect_fds(&mh, fds, VN_SCM_MAX_FD);
    truncated = (mh.msg_flags & MSG_CTRUNC) != 0 && s->accept_fds;
#if VN_MSG_CMSG_CLOEXEC == 0
    for (size_t i = 0; i < nfds; i++) (void)set_cloexec(fds[i]);
#endif
    if (truncated || !s->accept_fds || n == 0) {
      close_all(fds, nfds);
      nfds = 0;
    }
  }
  s->want_read = false;

  napi_handle_scope scope;
  if (napi_open_handle_scope(env, &scope) != napi_ok) {
    close_all(fds, nfds);
    return true;
  }
  napi_value argv[4] = {NULL, NULL, NULL, NULL};
  if (n < 0) {
    argv[0] = errno_error(env, err, "recvmsg");
    vn_emit(s, "onread", 4, argv);
    napi_close_handle_scope(env, scope);
    return true;
  }
  napi_get_null(env, &argv[0]);
  if (n == 0) {
    napi_get_null(env, &argv[1]);
  } else {
    void *copy;
    if (napi_create_buffer_copy(env, (size_t)n, buffer, &copy, &argv[1]) != napi_ok) {
      close_all(fds, nfds);
      bool pending = false;
      napi_value ignored;
      if (napi_is_exception_pending(env, &pending) == napi_ok && pending)
        (void)napi_get_and_clear_last_exception(env, &ignored);
      napi_value err_argv[4] = {errno_error(env, ENOMEM, "recvmsg"), NULL, NULL, make_bool(env, false)};
      vn_emit(s, "onread", 4, err_argv);
      napi_close_handle_scope(env, scope);
      return true;
    }
  }
  if (nfds > 0) {
    napi_value arr = fd_array_value(env, fds, nfds);
    if (arr == NULL) {
      // Could not hand them over: drop them like a truncation.
      close_all(fds, nfds);
      truncated = true;
    } else {
      argv[2] = arr;
      // Held by JS for the library from now on, until closed or handed to a user (release).
      for (size_t i = 0; i < nfds; i++) vn_track(s->inst, fds[i]);
    }
  }
  argv[3] = make_bool(env, truncated);
  vn_emit(s, "onread", 4, argv);
  napi_close_handle_scope(env, scope);
  return true;
}

/** The pending connect finished: `onconnect(error | null)`. */
static void vn_finish_connect(vn_socket *s, int status) {
  napi_env env = s->env;
  s->connecting = false;
  int err = 0;
  if (status < 0) {
    err = -status;
  } else {
    socklen_t len = sizeof err;
    if (getsockopt(s->fd, SOL_SOCKET, SO_ERROR, &err, &len) < 0) err = errno;
  }
  napi_handle_scope scope;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return;
  napi_value argv[1];
  if (err != 0)
    argv[0] = errno_error(env, err, "connect");
  else
    napi_get_null(env, &argv[0]);
  vn_emit(s, "onconnect", 1, argv);
  napi_close_handle_scope(env, scope);
}

static void vn_on_poll(uv_poll_t *handle, int status, int events) {
  vn_socket *s = handle->data;
  if (s->closed) return;
  napi_env env = s->env;
  if (s->connecting && (status < 0 || (events & UV_WRITABLE))) {
    vn_finish_connect(s, status);
    if (s->closed) return;
  }
  if (status < 0) {
    // The poll itself failed: report it to whoever waits.
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) return;
    if (s->want_write) {
      s->want_write = false;
      napi_value argv[1] = {errno_error(env, -status, "poll")};
      vn_emit(s, "onwritable", 1, argv);
    }
    if (!s->closed && s->want_read) {
      s->want_read = false;
      napi_value argv[4] = {errno_error(env, -status, "poll"), NULL, NULL, make_bool(env, false)};
      vn_emit(s, "onread", 4, argv);
    }
    napi_close_handle_scope(env, scope);
    if (!s->closed) (void)vn_update_poll(s);
    return;
  }
  if ((events & UV_WRITABLE) && s->want_write) {
    s->want_write = false;
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) == napi_ok) {
      napi_value argv[1];
      napi_get_null(env, &argv[0]);
      vn_emit(s, "onwritable", 1, argv);
      napi_close_handle_scope(env, scope);
    }
    if (s->closed) return;
  }
  if ((events & UV_READABLE) && s->want_read) {
    (void)vn_do_read(s);
    if (s->closed) return;
  }
  (void)vn_update_poll(s);
}

/** Wraps `fd` (already close-on-exec and non-blocking) in a new JS socket object; on failure the fd is closed. */
static napi_value vn_wrap(napi_env env, int fd, bool connecting) {
  napi_value obj;
  vn_socket *s = calloc(1, sizeof *s);
  if (s == NULL) {
    close_quietly(fd);
    return throw_errno(env, ENOMEM, "malloc");
  }
  s->env = env;
  s->fd = fd;
  s->connecting = connecting;
  s->ctrl_fds = VN_SCM_MAX_FD;
  s->pass_rights = -1;
  vn_instance *inst = NULL;
  napi_value ctor;
  if (VN_FAILED(napi_get_instance_data(env, (void **)&inst)) || inst == NULL ||
      VN_FAILED(napi_get_reference_value(env, inst->ctor, &ctor)) ||
      VN_FAILED(napi_new_instance(env, ctor, 0, NULL, &obj))) {
    close_quietly(fd);
    free(s);
    return NULL;
  }
  if (VN_FAILED(napi_wrap(env, obj, s, vn_finalize, NULL, &s->wrapper))) {
    close_quietly(fd);
    free(s);
    return NULL;
  }
  vn_link(inst, s);
  // From here on the finalizer owns `s` (and closes the fd).
  napi_value resource_name;
  if (VN_FAILED(napi_create_string_utf8(env, "VarlinkNativeSocket", NAPI_AUTO_LENGTH, &resource_name)) ||
      VN_FAILED(napi_async_init(env, obj, resource_name, &s->async_ctx))) {
    vn_close(s);
    return NULL;
  }
  uv_loop_t *loop;
  if (VN_FAILED(napi_get_uv_event_loop(env, &loop))) {
    vn_close(s);
    return NULL;
  }
  int r = uv_poll_init(loop, &s->poll, fd);
  if (r < 0) {
    vn_close(s);
    return throw_errno(env, -r, "uv_poll_init");
  }
  s->poll.data = s;
  s->poll_initialized = true;
  r = vn_update_poll(s);
  if (r < 0) {
    vn_close(s);
    return throw_errno(env, -r, "uv_poll_start");
  }
  return obj;
}

static vn_socket *vn_unwrap(napi_env env, napi_value self) {
  void *data = NULL;
  if (VN_FAILED(napi_unwrap(env, self, &data)) || data == NULL) {
    throw_plain(env, "ERR_INVALID_THIS", "not a varlink-js-native socket");
    return NULL;
  }
  return data;
}

/** Methods that need an open socket fetch it with this (throws EBADF once closed). */
static vn_socket *vn_open_this(napi_env env, napi_callback_info info, size_t want, napi_value *argv) {
  napi_value self;
  if (get_args(env, info, want, argv, &self) < 0) return NULL;
  vn_socket *s = vn_unwrap(env, self);
  if (s == NULL) return NULL;
  if (s->closed) {
    throw_errno(env, EBADF, "socket");
    return NULL;
  }
  return s;
}

static napi_value js_socket_ctor(napi_env env, napi_callback_info info) {
  napi_value self;
  if (VN_FAILED(napi_get_cb_info(env, info, NULL, NULL, &self, NULL))) return NULL;
  return self;
}

/** `sock.read()`: arm one recvmsg; the result comes as `onread(...)`. */
static napi_value js_read(napi_env env, napi_callback_info info) {
  vn_socket *s = vn_open_this(env, info, 0, NULL);
  if (s == NULL) return NULL;
  s->want_read = true;
  int r = vn_update_poll(s);
  if (r < 0) return throw_errno(env, -r, "uv_poll_start");
  return make_undefined(env);
}

/** `sock.wantWrite()`: `onwritable(null)` once the socket is writable. */
static napi_value js_want_write(napi_env env, napi_callback_info info) {
  vn_socket *s = vn_open_this(env, info, 0, NULL);
  if (s == NULL) return NULL;
  s->want_write = true;
  int r = vn_update_poll(s);
  if (r < 0) return throw_errno(env, -r, "uv_poll_start");
  return make_undefined(env);
}

/**
 * `sock.send(bytes, fds?)` → bytes written (≥ 0), or -1 if the socket buffer is full (EAGAIN). `fds` ride along
 * with the first byte (SCM_RIGHTS); pass them only with the first part of a message. MSG_NOSIGNAL: no SIGPIPE.
 */
static napi_value js_send(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  vn_socket *s = vn_open_this(env, info, 2, argv);
  if (s == NULL) return NULL;
  const uint8_t *data;
  size_t len;
  if (get_bytes(env, argv[0], &data, &len) < 0) return NULL;
  int fds[VN_SCM_MAX_FD];
  int nfds = get_fd_array(env, argv[1], fds);
  if (nfds < 0) return NULL;
  if (len == 0 && nfds > 0) return throw_plain(env, "ERR_INVALID_ARG_VALUE", "fds need at least one byte to ride on");
  struct iovec iov = {.iov_base = (void *)data, .iov_len = len};
  struct msghdr mh;
  vn_control control;
  memset(&mh, 0, sizeof mh);
  mh.msg_iov = &iov;
  mh.msg_iovlen = 1;
  if (nfds > 0) {
    memset(&control, 0, sizeof control);
    mh.msg_control = control.buf;
    mh.msg_controllen = CMSG_SPACE(sizeof(int) * (size_t)nfds);
    struct cmsghdr *c = CMSG_FIRSTHDR(&mh);
    c->cmsg_level = SOL_SOCKET;
    c->cmsg_type = SCM_RIGHTS;
    c->cmsg_len = CMSG_LEN(sizeof(int) * (size_t)nfds);
    memcpy(CMSG_DATA(c), fds, sizeof(int) * (size_t)nfds);
  }
  ssize_t n;
  do {
    n = sendmsg(s->fd, &mh, MSG_DONTWAIT | VN_MSG_NOSIGNAL);
  } while (n < 0 && errno == EINTR);
  int err = n < 0 ? errno : 0;
  if (n < 0) {
    if (err == EAGAIN || err == EWOULDBLOCK) return make_int(env, -1);
    // Linux ≥ 6.16: the receiving socket has SO_PASSRIGHTS off. The JS side turns it into a clear local error.
    return throw_errno(env, err, nfds > 0 && err == EPERM ? "sendmsg(SCM_RIGHTS)" : "sendmsg");
  }
  return make_int(env, (int64_t)n);
}

/** `sock.shutdownWrite()`: shutdown(SHUT_WR). */
static napi_value js_shutdown_write(napi_env env, napi_callback_info info) {
  vn_socket *s = vn_open_this(env, info, 0, NULL);
  if (s == NULL) return NULL;
  if (shutdown(s->fd, SHUT_WR) < 0) {
    int err = errno;
    return throw_errno(env, err, "shutdown");
  }
  return make_undefined(env);
}

/** `sock.close()`: stops polling and closes the fd. Idempotent. */
static napi_value js_close(napi_env env, napi_callback_info info) {
  napi_value self;
  if (get_args(env, info, 0, NULL, &self) < 0) return NULL;
  vn_socket *s = vn_unwrap(env, self);
  if (s == NULL) return NULL;
  vn_close(s);
  return make_undefined(env);
}

static napi_value js_is_connecting(napi_env env, napi_callback_info info) {
  napi_value self;
  if (get_args(env, info, 0, NULL, &self) < 0) return NULL;
  vn_socket *s = vn_unwrap(env, self);
  if (s == NULL) return NULL;
  return make_bool(env, s->connecting);
}

static napi_value js_get_fd(napi_env env, napi_callback_info info) {
  napi_value self;
  if (get_args(env, info, 0, NULL, &self) < 0) return NULL;
  vn_socket *s = vn_unwrap(env, self);
  if (s == NULL) return NULL;
  return make_int(env, s->fd);
}

/** A boolean argument; false with an Error thrown otherwise. */
static bool get_bool(napi_env env, napi_value v, const char *what, bool *out) {
  napi_valuetype t;
  if (VN_FAILED(napi_typeof(env, v, &t))) return false;
  if (t != napi_boolean) {
    char message[96];
    snprintf(message, sizeof message, "%s must be a boolean", what);
    throw_plain(env, "ERR_INVALID_ARG_TYPE", message);
    return false;
  }
  return napi_get_value_bool(env, v, out) == napi_ok;
}

/**
 * SO_PASSRIGHTS (Linux ≥ 6.16) on `fd`: whether the kernel takes SCM_RIGHTS for it (off: a sender's sendmsg with fds
 * fails with EPERM). 1 = set, 0 = this kernel has no such option (ENOPROTOOPT/EINVAL, ignored as
 * json_stream_set_allow_fd_passing_input ignores "not supported", json-stream.c:705-708), -1 = another error (errno).
 */
static int set_pass_rights(int fd, bool on) {
#ifdef SO_PASSRIGHTS
  int v = on ? 1 : 0;
  if (setsockopt(fd, SOL_SOCKET, SO_PASSRIGHTS, &v, sizeof v) == 0) return 1;
  if (errno == ENOPROTOOPT || errno == EINVAL || errno == EOPNOTSUPP) return 0;
  return -1;
#else
  (void)fd;
  (void)on;
  return 0;
#endif
}

/**
 * `sock.setAcceptFds(on, passRights = false)`: whether received fds are delivered (else closed, silently, see
 * vn_do_read); while on, reads are bounded at message boundaries. SO_PASSRIGHTS is touched only when `passRights` is
 * true (the strict mode: SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT, whose server connections get the per-connection
 * setsockopt, sd-varlink.c:3347-3352): always on the first such call (the value is unknown: it may come from the
 * listening socket), then only when it changes (json_stream_set_allow_fd_passing_input returns early otherwise,
 * json-stream.c:691-692); never touched, the socket keeps the kernel default (on), and fds
 * that come while input is off are dropped by the read path, as by sd-varlink's plain recv() (json-stream.c:1318-1321).
 */
static napi_value js_set_accept_fds(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  vn_socket *s = vn_open_this(env, info, 2, argv);
  if (s == NULL) return NULL;
  bool on;
  if (!get_bool(env, argv[0], "on", &on)) return NULL;
  bool pass_rights = false;
  napi_valuetype t;
  if (VN_FAILED(napi_typeof(env, argv[1], &t))) return NULL;
  if (t != napi_undefined && !get_bool(env, argv[1], "passRights", &pass_rights)) return NULL;
  s->accept_fds = on;
  int want = on ? 1 : 0;
  // Unknown (-1) is not assumed to be the kernel default: an accepted socket inherits its listener's value, which
  // strict mode may have set off (or a service manager's PassRights=). So the first strict call always sets it. For
  // a first *allow* that matches sd-varlink, whose tracked flag starts off so that it reaches the setsockopt
  // (sd-varlink.c:3612, json-stream.c:691-692, 705-708); for a first *disallow* sd-varlink returns early (its flag is
  // already off, json-stream.c:691-692) and leaves the inherited value, while we set it off: stricter, and the same
  // result whenever the listener was set up with the server's value. Later calls skip it while the value does not
  // change.
  if (pass_rights && s->pass_rights != want) {
    if (s->inst != NULL) s->inst->pass_rights_calls++;
    int r = set_pass_rights(s->fd, on);
    if (r < 0) {
      int err = errno;
      return throw_errno(env, err, "setsockopt");
    }
    // Recorded also when the kernel has no SO_PASSRIGHTS (r == 0), as json-stream.c:711 sets the flag after ignoring
    // "not supported": later calls with the same value do not re-issue a setsockopt that can only fail.
    s->pass_rights = want;
  }
  return make_undefined(env);
}

/** Test hook: the recvmsg control buffer's capacity in fds (0-253), to provoke MSG_CTRUNC. */
static napi_value js_set_control_buffer_fds(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  vn_socket *s = vn_open_this(env, info, 1, argv);
  if (s == NULL) return NULL;
  napi_valuetype t;
  if (VN_FAILED(napi_typeof(env, argv[0], &t))) return NULL;
  if (t != napi_number) return throw_plain(env, "ERR_INVALID_ARG_TYPE", "control buffer fds must be a number");
  int32_t n;
  if (VN_FAILED(napi_get_value_int32(env, argv[0], &n))) return NULL;
  if (n < 0 || n > VN_SCM_MAX_FD) return throw_plain(env, "ERR_OUT_OF_RANGE", "control buffer fds must be 0-253");
  s->ctrl_fds = n;
  return make_undefined(env);
}

static napi_value js_ref(napi_env env, napi_callback_info info) {
  napi_value self;
  if (get_args(env, info, 0, NULL, &self) < 0) return NULL;
  vn_socket *s = vn_unwrap(env, self);
  if (s == NULL) return NULL;
  if (!s->closed && s->poll_initialized && s->unrefd) {
    uv_ref((uv_handle_t *)&s->poll);
    s->unrefd = false;
  }
  return make_undefined(env);
}

static napi_value js_unref(napi_env env, napi_callback_info info) {
  napi_value self;
  if (get_args(env, info, 0, NULL, &self) < 0) return NULL;
  vn_socket *s = vn_unwrap(env, self);
  if (s == NULL) return NULL;
  if (!s->closed && s->poll_initialized && !s->unrefd) {
    uv_unref((uv_handle_t *)&s->poll);
    s->unrefd = true;
  }
  return make_undefined(env);
}

static int set_int_prop(napi_env env, napi_value obj, const char *name, int64_t n) {
  napi_value v = make_int(env, n);
  if (v == NULL) return -1;
  return napi_set_named_property(env, obj, name, v) == napi_ok ? 0 : -1;
}

/**
 * `sock.peerCred()` → `{uid, gid, pid}`. Linux: SO_PEERCRED (the peer's credentials at connect() time). macOS:
 * getpeereid + LOCAL_PEERPID. The pidfd is separate (peerPidfd), fetched only when someone asks for it.
 */
static napi_value js_peer_cred(napi_env env, napi_callback_info info) {
  vn_socket *s = vn_open_this(env, info, 0, NULL);
  if (s == NULL) return NULL;
  int64_t uid, gid, pid;
#if defined(__linux__)
  struct ucred cred;
  socklen_t len = sizeof cred;
  if (getsockopt(s->fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) < 0) {
    int err = errno;
    return throw_errno(env, err, "getsockopt");
  }
  if (len != sizeof cred) return throw_errno(env, EIO, "getsockopt");
  uid = cred.uid;
  gid = cred.gid;
  pid = cred.pid;
#elif defined(__APPLE__)
  uid_t u;
  gid_t g;
  if (getpeereid(s->fd, &u, &g) < 0) {
    int err = errno;
    return throw_errno(env, err, "getpeereid");
  }
  pid_t p = 0;
  socklen_t len = sizeof p;
  if (getsockopt(s->fd, SOL_LOCAL, LOCAL_PEERPID, &p, &len) < 0) {
    int err = errno;
    return throw_errno(env, err, "getsockopt");
  }
  uid = u;
  gid = g;
  pid = p;
#else
  return throw_errno(env, ENOTSUP, "getsockopt");
#endif
  napi_value obj;
  if (VN_FAILED(napi_create_object(env, &obj)) || set_int_prop(env, obj, "uid", uid) < 0 ||
      set_int_prop(env, obj, "gid", gid) < 0 || set_int_prop(env, obj, "pid", pid) < 0)
    return NULL;
  return obj;
}

/**
 * `sock.peerPidfd(track = false)` → a new close-on-exec pidfd of the peer (SO_PEERPIDFD, Linux ≥ 6.5; the caller owns
 * it), or null where there is none (older kernels: ENOPROTOOPT; the peer gone: ESRCH/ENODATA; macOS). SO_PEERPIDFD
 * refers to the process that connected, whenever it is asked, so it may be fetched lazily. `track` (varlink-js, for
 * the pidfd its channel holds): tracked like a received fd, closed at environment teardown unless closed before.
 */
static napi_value js_peer_pidfd(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  vn_socket *s = vn_open_this(env, info, 1, argv);
  if (s == NULL) return NULL;
  bool track = false;
  napi_valuetype t;
  if (VN_FAILED(napi_typeof(env, argv[0], &t))) return NULL;
  if (t != napi_undefined && !get_bool(env, argv[0], "track", &track)) return NULL;
  napi_value none;
  napi_get_null(env, &none);
#if defined(__linux__) && defined(SO_PEERPIDFD)
  int pfd = -1;
  socklen_t plen = sizeof pfd;
  if (getsockopt(s->fd, SOL_SOCKET, SO_PEERPIDFD, &pfd, &plen) < 0 || plen != sizeof pfd || pfd < 0) return none;
  if (set_cloexec(pfd) != 0) {
    close_quietly(pfd);
    return none;
  }
  napi_value v = make_int(env, pfd);
  if (v == NULL)
    close_quietly(pfd);
  else if (track)
    vn_track(s->inst, pfd);
  return v;
#else
  (void)track;
  return none;
#endif
}

// ---------------------------------------------------------------------------------------------------------------
// Module functions

/**
 * `connect(address)` → socket. `address`: the sun_path bytes (a leading NUL = abstract, exact length; else a path,
 * NUL-terminated here). socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK) + connect(). EINPROGRESS: the
 * socket polls for writability and reports `onconnect(error | null)` (SO_ERROR); `isConnecting()` says so.
 * Anything else, EAGAIN (a full backlog: AF_UNIX does not queue the connect) included, throws, like libuv's
 * uv_pipe_connect.
 */
static napi_value js_connect(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (get_args(env, info, 1, argv, NULL) < 0) return NULL;
  const uint8_t *addr;
  size_t len;
  if (get_bytes(env, argv[0], &addr, &len) < 0) return NULL;
  struct sockaddr_un sa;
  memset(&sa, 0, sizeof sa);
  sa.sun_family = AF_UNIX;
  socklen_t salen;
  if (len == 0) return throw_errno(env, EINVAL, "connect");
  if (addr[0] == 0) {
    // Abstract (Linux): the leading NUL plus the name, no terminator.
    if (len > sizeof sa.sun_path) return throw_errno(env, ENAMETOOLONG, "connect");
    memcpy(sa.sun_path, addr, len);
    salen = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + len);
  } else {
    if (memchr(addr, 0, len) != NULL) return throw_errno(env, EINVAL, "connect");
    if (len >= sizeof sa.sun_path) return throw_errno(env, ENAMETOOLONG, "connect");
    memcpy(sa.sun_path, addr, len);
    salen = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + len + 1);
  }
#ifdef __APPLE__
  sa.sun_len = (uint8_t)salen;
#endif
  int fd;
#if defined(SOCK_CLOEXEC) && defined(SOCK_NONBLOCK)
  fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (fd < 0) return throw_errno(env, errno, "socket");
#else
  fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return throw_errno(env, errno, "socket");
  int e;
  if ((e = set_cloexec(fd)) != 0 || (e = set_nonblock(fd)) != 0) {
    close_quietly(fd);
    return throw_errno(env, e, "fcntl");
  }
#endif
  int e2 = set_nosigpipe(fd);
  if (e2 != 0) {
    close_quietly(fd);
    return throw_errno(env, e2, "setsockopt");
  }
  int r = connect(fd, (struct sockaddr *)&sa, salen);
  bool connecting = false;
  if (r < 0) {
    if (errno == EINPROGRESS || errno == EINTR) {
      connecting = true;
    } else {
      int err = errno;
      close_quietly(fd);
      return throw_errno(env, err, "connect");
    }
  }
  return vn_wrap(env, fd, connecting);
}

/**
 * `adopt(fd)` → socket over a duplicate of `fd` (F_DUPFD_CLOEXEC, made non-blocking). The caller keeps `fd` (e.g.
 * an accepted Node socket's fd, which Node closes when that socket is destroyed). Not a socket: ENOTSOCK.
 */
static napi_value js_adopt(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (get_args(env, info, 1, argv, NULL) < 0) return NULL;
  int fd = get_fd(env, argv[0]);
  if (fd < 0) return NULL;
  struct stat st;
  if (fstat(fd, &st) < 0) return throw_errno(env, errno, "fstat");
  if (!S_ISSOCK(st.st_mode)) return throw_errno(env, ENOTSOCK, "adopt");
  int copy = dup_cloexec(fd);
  if (copy < 0) return throw_errno(env, errno, "fcntl");
  int e;
  if ((e = set_nonblock(copy)) != 0 || (e = set_nosigpipe(copy)) != 0) {
    close_quietly(copy);
    return throw_errno(env, e, "fcntl");
  }
  return vn_wrap(env, copy, false);
}

/**
 * `dup(fd, track = false)` → a close-on-exec duplicate (≥ 3), owned by the caller. `track` (varlink-js, for the
 * duplicates it holds, FdPassing.duplicate): tracked as held by this environment, closed at its teardown unless
 * closed with close() or forgotten with release() before.
 */
static napi_value js_dup(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (get_args(env, info, 2, argv, NULL) < 0) return NULL;
  int fd = get_fd(env, argv[0]);
  if (fd < 0) return NULL;
  bool track = false;
  napi_valuetype t;
  if (VN_FAILED(napi_typeof(env, argv[1], &t))) return NULL;
  if (t != napi_undefined && !get_bool(env, argv[1], "track", &track)) return NULL;
  int copy = dup_cloexec(fd);
  if (copy < 0) {
    int err = errno;
    return throw_errno(env, err, "fcntl");
  }
  napi_value v = make_int(env, copy);
  if (v == NULL)
    close_quietly(copy);
  else if (track)
    vn_track(vn_inst(env), copy);
  return v;
}

/** `close(fd)`: forgets it (if tracked) and closes it. EINTR counts as closed (not retried); EBADF throws. */
static napi_value js_close_fd(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (get_args(env, info, 1, argv, NULL) < 0) return NULL;
  int fd = get_fd(env, argv[0]);
  if (fd < 0) return NULL;
  (void)vn_untrack(vn_inst(env), fd);
  if (close(fd) < 0 && errno != EINTR) {
    int err = errno;
    return throw_errno(env, err, "close");
  }
  return make_undefined(env);
}

/**
 * `release(fd)` → whether it was tracked: the environment stops tracking `fd` (received, dup'ed, a pidfd) because it
 * was handed to a user, who owns it from now on; the teardown hook will not close it.
 */
static napi_value js_release(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (get_args(env, info, 1, argv, NULL) < 0) return NULL;
  int fd = get_fd(env, argv[0]);
  if (fd < 0) return NULL;
  return make_bool(env, vn_untrack(vn_inst(env), fd));
}

/**
 * Test hook: `stats()` → `{ trackedFds, boundedCuts, peekWidenings, passRightsCalls, anonProbe }` of this
 * environment, plus `teardownSkipped` of the whole process.
 */
static napi_value js_stats(napi_env env, napi_callback_info info) {
  (void)info;
  vn_instance *inst = vn_inst(env);
  napi_value obj, probe_v;
#ifdef __linux__
  const char *probe = inst == NULL || !inst->anon_known           ? "none"
                      : inst->anon_probe == VN_PROBE_EVENTFD ? "eventfd"
                                                             : "epoll";
#else
  const char *probe = "unsupported";
#endif
  if (VN_FAILED(napi_create_object(env, &obj))) return NULL;
  if (VN_FAILED(napi_create_string_utf8(env, probe, NAPI_AUTO_LENGTH, &probe_v)) ||
      VN_FAILED(napi_set_named_property(env, obj, "anonProbe", probe_v)))
    return NULL;
  if (set_int_prop(env, obj, "teardownSkipped",
                   (int64_t)__atomic_load_n(&vn_teardown_skipped, __ATOMIC_RELAXED)) < 0 ||
      set_int_prop(env, obj, "trackedFds", inst == NULL ? 0 : (int64_t)inst->n_fds) < 0 ||
      set_int_prop(env, obj, "boundedCuts", inst == NULL ? 0 : (int64_t)inst->bounded_cuts) < 0 ||
      set_int_prop(env, obj, "peekWidenings", inst == NULL ? 0 : (int64_t)inst->peek_widenings) < 0 ||
      set_int_prop(env, obj, "passRightsCalls", inst == NULL ? 0 : (int64_t)inst->pass_rights_calls) < 0)
    return NULL;
  return obj;
}

/** `setCloexec(fd)`: sets FD_CLOEXEC (e.g. on inherited activation fds, as sd_listen_fds does). */
static napi_value js_set_cloexec(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (get_args(env, info, 1, argv, NULL) < 0) return NULL;
  int fd = get_fd(env, argv[0]);
  if (fd < 0) return NULL;
  int e = set_cloexec(fd);
  if (e != 0) return throw_errno(env, e, "fcntl");
  return make_undefined(env);
}

/**
 * `setPassRights(fd, on)` → whether this kernel has SO_PASSRIGHTS (Linux ≥ 6.16; then it was set). For listening
 * sockets: accepted connections inherit it, so setting it before accept closes the window in which a client could
 * still send fds. sd-varlink does this only with SD_VARLINK_SERVER_FD_PASSING_INPUT_STRICT (sd-varlink.c:3787-3792
 * for an inherited fd, 3851-3853 before bind for one it creates); the library calls it only in that strict mode.
 */
static napi_value js_set_pass_rights(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (get_args(env, info, 2, argv, NULL) < 0) return NULL;
  int fd = get_fd(env, argv[0]);
  if (fd < 0) return NULL;
  bool on;
  if (!get_bool(env, argv[1], "on", &on)) return NULL;
  int r = set_pass_rights(fd, on);
  if (r < 0) {
    int err = errno;
    return throw_errno(env, err, "setsockopt");
  }
  return make_bool(env, r == 1);
}

/** `isUnixSocket(fd)`: whether `fd` is an AF_UNIX socket (false for other sockets and non-sockets). */
static napi_value js_is_unix_socket(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (get_args(env, info, 1, argv, NULL) < 0) return NULL;
  int fd = get_fd(env, argv[0]);
  if (fd < 0) return NULL;
  struct sockaddr_storage ss;
  socklen_t len = sizeof ss;
  memset(&ss, 0, sizeof ss);
  if (getsockname(fd, (struct sockaddr *)&ss, &len) < 0) {
    if (errno == ENOTSOCK) return make_bool(env, false);
    return throw_errno(env, errno, "getsockname");
  }
  return make_bool(env, ss.ss_family == AF_UNIX);
}

/** `pipe()` → `[readFd, writeFd]`, both close-on-exec (tests and callers that want a pipe to pass). */
static napi_value js_pipe(napi_env env, napi_callback_info info) {
  (void)info;
  int p[2];
#ifdef __linux__
  if (pipe2(p, O_CLOEXEC) < 0) return throw_errno(env, errno, "pipe2");
#else
  if (pipe(p) < 0) return throw_errno(env, errno, "pipe");
  int e;
  if ((e = set_cloexec(p[0])) != 0 || (e = set_cloexec(p[1])) != 0) {
    close_all(p, 2);
    return throw_errno(env, e, "fcntl");
  }
#endif
  napi_value arr = fd_array_value(env, p, 2);
  if (arr == NULL) close_all(p, 2);
  return arr;
}

/** `user.varlink` = `value` on the socket `fd` (sd-varlink.c:165-190). Linux only (else ENOTSUP). */
static napi_value js_set_xattr(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (get_args(env, info, 2, argv, NULL) < 0) return NULL;
  int fd = get_fd(env, argv[0]);
  if (fd < 0) return NULL;
  char *value = get_string(env, argv[1], "value");
  if (value == NULL) return NULL;
#ifdef __linux__
  int r = fsetxattr(fd, "user.varlink", value, strlen(value), 0);
  int err = errno;
  free(value);
  if (r < 0) return throw_errno(env, err, "fsetxattr");
  return make_undefined(env);
#else
  free(value);
  return throw_errno(env, ENOTSUP, "fsetxattr");
#endif
}

/** Removes `user.varlink` from the socket `fd` (sd-varlink.c:192-211: ENODATA is no error). Linux only. */
static napi_value js_remove_xattr(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (get_args(env, info, 1, argv, NULL) < 0) return NULL;
  int fd = get_fd(env, argv[0]);
  if (fd < 0) return NULL;
#ifdef __linux__
  if (fremovexattr(fd, "user.varlink") < 0 && errno != ENODATA) return throw_errno(env, errno, "fremovexattr");
  return make_undefined(env);
#else
  return throw_errno(env, ENOTSUP, "fremovexattr");
#endif
}

/** `user.varlink` = `value` on the file at `path` (the "entrypoint" role, sd-varlink.c:3864). Linux only. */
static napi_value js_set_path_xattr(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (get_args(env, info, 2, argv, NULL) < 0) return NULL;
  char *path = get_string(env, argv[0], "path");
  if (path == NULL) return NULL;
  char *value = get_string(env, argv[1], "value");
  if (value == NULL) {
    free(path);
    return NULL;
  }
#ifdef __linux__
  int r = setxattr(path, "user.varlink", value, strlen(value), 0);
  int err = errno;
  free(path);
  free(value);
  if (r < 0) return throw_errno(env, err, "setxattr");
  return make_undefined(env);
#else
  free(path);
  free(value);
  return throw_errno(env, ENOTSUP, "setxattr");
#endif
}

/**
 * `memfdSealed(name, bytes)` → a read-only, sealed memfd holding `bytes`, positioned at 0 (varlinkctl --exec puts
 * the reply on stdin this way: memfd_new_and_seal_string, varlinkctl.c:1128). Linux only (else ENOSYS).
 */
static napi_value js_memfd_sealed(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (get_args(env, info, 2, argv, NULL) < 0) return NULL;
  char *name = get_string(env, argv[0], "name");
  if (name == NULL) return NULL;
  const uint8_t *data;
  size_t len;
  if (get_bytes(env, argv[1], &data, &len) < 0) {
    free(name);
    return NULL;
  }
#ifdef __linux__
  int fd = (int)syscall(SYS_memfd_create, name, MFD_CLOEXEC | MFD_ALLOW_SEALING);
  int err = errno;
  free(name);
  if (fd < 0) return throw_errno(env, err, "memfd_create");
  size_t off = 0;
  while (off < len) {
    ssize_t n = write(fd, data + off, len - off);
    if (n < 0) {
      if (errno == EINTR) continue;
      err = errno;
      close_quietly(fd);
      return throw_errno(env, err, "write");
    }
    off += (size_t)n;
  }
  if (fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE | F_SEAL_SEAL) < 0) {
    err = errno;
    close_quietly(fd);
    return throw_errno(env, err, "fcntl");
  }
  if (lseek(fd, 0, SEEK_SET) < 0) {
    err = errno;
    close_quietly(fd);
    return throw_errno(env, err, "lseek");
  }
  return make_int(env, fd);
#else
  free(name);
  return throw_errno(env, ENOSYS, "memfd_create");
#endif
}

/** Test hook: `eventfd()` → a close-on-exec, non-blocking eventfd (an fd on the anon inode; a read of a zero counter
 * fails with EAGAIN instead of hanging a test). Linux only (else ENOSYS). */
static napi_value js_eventfd(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef __linux__
  int fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
  if (fd < 0) return throw_errno(env, errno, "eventfd");
  napi_value v = make_int(env, fd);
  if (v == NULL) close_quietly(fd);
  return v;
#else
  return throw_errno(env, ENOSYS, "eventfd");
#endif
}

/** Test hook: `pidfdOpen(pid)` → a close-on-exec pidfd of `pid` (pidfd_open, Linux ≥ 5.3; else ENOSYS). */
static napi_value js_pidfd_open(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (get_args(env, info, 1, argv, NULL) < 0) return NULL;
  int pid = get_nonneg_int(env, argv[0], "pid must be a non-negative integer");
  if (pid < 0) return NULL;
#if defined(__linux__) && defined(SYS_pidfd_open)
  int fd = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
  if (fd < 0) return throw_errno(env, errno, "pidfd_open");
  napi_value v = make_int(env, fd);
  if (v == NULL) close_quietly(fd);
  return v;
#else
  return throw_errno(env, ENOSYS, "pidfd_open");
#endif
}

// ---------------------------------------------------------------------------------------------------------------
// Registration

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"read", NULL, js_read, NULL, NULL, NULL, napi_default, NULL},
      {"wantWrite", NULL, js_want_write, NULL, NULL, NULL, napi_default, NULL},
      {"send", NULL, js_send, NULL, NULL, NULL, napi_default, NULL},
      {"shutdownWrite", NULL, js_shutdown_write, NULL, NULL, NULL, napi_default, NULL},
      {"close", NULL, js_close, NULL, NULL, NULL, napi_default, NULL},
      {"isConnecting", NULL, js_is_connecting, NULL, NULL, NULL, napi_default, NULL},
      {"getFd", NULL, js_get_fd, NULL, NULL, NULL, napi_default, NULL},
      {"setAcceptFds", NULL, js_set_accept_fds, NULL, NULL, NULL, napi_default, NULL},
      {"setControlBufferFds", NULL, js_set_control_buffer_fds, NULL, NULL, NULL, napi_default, NULL},
      {"peerCred", NULL, js_peer_cred, NULL, NULL, NULL, napi_default, NULL},
      {"peerPidfd", NULL, js_peer_pidfd, NULL, NULL, NULL, napi_default, NULL},
      {"ref", NULL, js_ref, NULL, NULL, NULL, napi_default, NULL},
      {"unref", NULL, js_unref, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_value ctor;
  if (VN_FAILED(napi_define_class(env, "NativeSocket", NAPI_AUTO_LENGTH, js_socket_ctor, NULL,
                                  sizeof methods / sizeof methods[0], methods, &ctor)))
    return NULL;
  vn_instance *inst = calloc(1, sizeof *inst);
  if (inst == NULL) return throw_errno(env, ENOMEM, "malloc");
  inst->read_buffer = malloc(VN_READ_SIZE);
  if (inst->read_buffer == NULL) {
    free(inst);
    return throw_errno(env, ENOMEM, "malloc");
  }
#ifdef __linux__
  // The anon inode's identity, for vn_close_tracked (an eventfd lives on it; an epoll fd too, tried if eventfd fails).
  uint8_t probe = VN_PROBE_EVENTFD;
  int efd = eventfd(0, EFD_CLOEXEC);
  if (efd < 0) {
    probe = VN_PROBE_EPOLL;
    efd = epoll_create1(EPOLL_CLOEXEC);
  }
  if (efd >= 0) {
    struct stat st;
    if (fstat(efd, &st) == 0) {
      inst->anon_known = true;
      inst->anon_probe = probe;
      inst->anon_dev = st.st_dev;
      inst->anon_ino = st.st_ino;
    }
    close_quietly(efd);
  }
#endif
  if (VN_FAILED(napi_create_reference(env, ctor, 1, &inst->ctor))) {
    free(inst->read_buffer);
    free(inst);
    return NULL;
  }
  if (VN_FAILED(napi_set_instance_data(env, inst, vn_instance_free, NULL))) {
    napi_delete_reference(env, inst->ctor);
    free(inst->read_buffer);
    free(inst);
    return NULL;
  }
  // Registered after the instance data, so it runs before napi's own teardown (cleanup hooks run in reverse order):
  // the sockets' poll handles are closed while the loop still turns.
  napi_async_cleanup_hook_handle hook;
  if (VN_FAILED(napi_add_async_cleanup_hook(env, vn_cleanup_hook, inst, &hook))) return NULL;

  napi_property_descriptor functions[] = {
      {"connect", NULL, js_connect, NULL, NULL, NULL, napi_enumerable, NULL},
      {"adopt", NULL, js_adopt, NULL, NULL, NULL, napi_enumerable, NULL},
      {"dup", NULL, js_dup, NULL, NULL, NULL, napi_enumerable, NULL},
      {"close", NULL, js_close_fd, NULL, NULL, NULL, napi_enumerable, NULL},
      {"setCloexec", NULL, js_set_cloexec, NULL, NULL, NULL, napi_enumerable, NULL},
      {"isUnixSocket", NULL, js_is_unix_socket, NULL, NULL, NULL, napi_enumerable, NULL},
      {"setPassRights", NULL, js_set_pass_rights, NULL, NULL, NULL, napi_enumerable, NULL},
      {"release", NULL, js_release, NULL, NULL, NULL, napi_enumerable, NULL},
      {"stats", NULL, js_stats, NULL, NULL, NULL, napi_enumerable, NULL},
      {"pipe", NULL, js_pipe, NULL, NULL, NULL, napi_enumerable, NULL},
      {"setXattr", NULL, js_set_xattr, NULL, NULL, NULL, napi_enumerable, NULL},
      {"removeXattr", NULL, js_remove_xattr, NULL, NULL, NULL, napi_enumerable, NULL},
      {"setPathXattr", NULL, js_set_path_xattr, NULL, NULL, NULL, napi_enumerable, NULL},
      {"memfdSealed", NULL, js_memfd_sealed, NULL, NULL, NULL, napi_enumerable, NULL},
      {"eventfd", NULL, js_eventfd, NULL, NULL, NULL, napi_enumerable, NULL},
      {"pidfdOpen", NULL, js_pidfd_open, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  if (VN_FAILED(napi_define_properties(env, exports, sizeof functions / sizeof functions[0], functions)))
    return NULL;
  napi_value max_fd;
  if (VN_FAILED(napi_create_int32(env, VN_SCM_MAX_FD, &max_fd)) ||
      VN_FAILED(napi_set_named_property(env, exports, "SCM_MAX_FD", max_fd)))
    return NULL;
  return exports;
}

NAPI_MODULE_INIT() { return Init(env, exports); }
