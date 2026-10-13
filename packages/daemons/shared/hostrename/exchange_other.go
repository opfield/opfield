//go:build !linux

package hostrename

import "errors"

var errExchangeUnsupported = errors.New("rename exchange is not supported")

func exchange(string, string) error { return errExchangeUnsupported }

func renameNoReplace(a, b string) error { return renameIfAbsent(a, b) }
