//go:build !linux

package naming

import "errors"

var errExchangeUnsupported = errors.New("rename exchange is not supported")

func exchange(string, string) error { return errExchangeUnsupported }
