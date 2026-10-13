//go:build !linux

package hostrename

import "errors"

var errExchangeUnsupported = errors.New("rename exchange is not supported")

func exchange(string, string) error { return errExchangeUnsupported }
