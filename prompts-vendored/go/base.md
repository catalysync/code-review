---
id: go
description: Go idioms and security — sourced from gosec, staticcheck, the Go community style guide.
extends: [_base/universal]
---

# Go checks

Apply on Go code.

## Errors

- **Ignored errors** — `f, _ := os.Open(...)`. Flag unless the function's contract genuinely doesn't need the error and a comment explains why.
- **`if err != nil { return err }` losing context** — flag if the error will surface to a user without enough context to debug. Suggest `fmt.Errorf("opening config: %w", err)`.
- **Comparing errors with `==`** instead of `errors.Is(...)` — flag, breaks under wrapped errors.
- **Type-asserting an error with `.(T)`** instead of `errors.As(...)` — same.
- **`panic` in a library function** — flag block-severity unless the function is documented as panicking on misuse (e.g., `regexp.MustCompile`).

## Concurrency

- **Goroutines without a way to wait** — `go doStuff()` fired from `main` or `init` without a `sync.WaitGroup`/channel will be GC'd or leaked. Flag.
- **Loop variable capture** — `for _, v := range items { go func() { use(v) } }`. Pre-Go-1.22 this captures the loop variable; flag if the project's `go.mod` declares `go 1.21` or earlier. Fix: pass `v` as an argument.
- **`sync.Mutex` copied by value** — flag block-severity.
- **Closing a channel from the receiver side** — flag, only the sender should close.
- **Reading from a `nil` channel** — blocks forever. Flag if reachable.

## Security

(From gosec.)

- **`exec.Command(name, args...)` with `name` from user input** — flag, command injection.
- **`fmt.Sprintf("...%s...", userInput)` into SQL** — flag block-severity.
- **`http.ListenAndServe(":80", nil)` with no read/write timeouts** — flag, slowloris DoS. Use `http.Server{ReadTimeout: ..., WriteTimeout: ...}`.
- **`crypto/md5`, `crypto/sha1`** for security purposes — flag. Use `crypto/sha256` or higher.
- **`math/rand` for tokens / secrets** — flag, predictable. Use `crypto/rand`.
- **`tls.Config{InsecureSkipVerify: true}`** — flag block-severity.
- **`http.Get(userURL)`** — flag SSRF risk if `userURL` is from request input.
- **Unbounded `io.ReadAll(r)`** on an HTTP body — flag, memory DoS. Use `io.LimitReader`.
- **`os.OpenFile(name, ..., 0666)`** — flag, world-writable. Use `0600` or `0644` per intent.

## Resource management

- **Missing `defer file.Close()`** after `os.Open` — flag, leak.
- **`defer` in a loop** — flag, defers stack up until function returns. Move into a closure.
- **`time.After` in a `select` inside a loop** — leaks the timer. Use `time.NewTimer` + explicit `Stop`.

## Performance

- **`fmt.Sprintf` for simple concat** — flag with severity low, suggest `+` or `strings.Builder`.
- **`json.Marshal` of a large slice without streaming** — flag if the slice can be large.
- **`map[string]*Foo` returned from a hot function** — flag if the map is short-lived; consider a slice + lookup.

## Conventions

- **Package comment missing** on exported package — flag with severity low.
- **Exported function without a doc comment** — flag with severity low if the project documents other exports.
- **`interface{}` (or `any`) parameters** for typed inputs — flag, suggest a real interface or generic.
