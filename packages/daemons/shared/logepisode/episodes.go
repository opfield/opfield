// Package logepisode turns per-request outcomes of many subjects (Secure Links, relay endpoints) into a few log lines
// per state change. During an outage a daemon sees every request of a route fail, and with retries inside each request
// logging every attempt wrote about 20 WARN lines per failed request (L-1: ~2k lines per 5 min for one route at
// 0.6 req/s). A Tracker logs the change into "failing" once, reminds of a subject that keeps failing every few minutes
// with counts, and logs the recovery with the counts of the episode. Per-attempt detail belongs at debug level.
package logepisode

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// DefaultReminder is how often a subject that stays in one bad state is summarised again.
const DefaultReminder = 5 * time.Minute

// idleExpiry drops the episode of a subject that saw no request for this long (a deleted link, a route nobody uses).
const idleExpiry = time.Hour

// Subject names what the outcomes belong to. Name starts every log line ("proxy secure-link connections");
// IDAttr and ID identify the subject in it ("link_id", "3acf26af-…"). Name and ID together key the episode.
type Subject struct {
	Name   string
	IDAttr string
	ID     string
}

type subjectKey struct{ name, id string }

type state int

const (
	// retrying: requests succeed, but only after failed attempts or a hold.
	retrying state = iota + 1
	// failing: requests fail.
	failing
)

type episode struct {
	state      state
	started    time.Time // the episode, from the first bad outcome
	since      time.Time // the current state
	reported   time.Time // the last line logged
	lastEvent  time.Time
	failed     int // over the episode
	retried    int // over the episode
	unreported int // outcomes of the current state since the last line
}

// Tracker aggregates outcomes per subject. The zero value is ready to use and safe for concurrent use.
type Tracker struct {
	// Reminder overrides DefaultReminder.
	Reminder time.Duration
	// Now overrides the clock (tests).
	Now func() time.Time
	// Errors logs failures at error instead of warn level.
	Errors bool

	mu       sync.Mutex
	episodes map[subjectKey]*episode
	pruned   time.Time
}

func (t *Tracker) now() time.Time {
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
}

func (t *Tracker) reminder() time.Duration {
	if t.Reminder > 0 {
		return t.Reminder
	}
	return DefaultReminder
}

// episodeLocked returns the subject's episode, starting one when create is set.
func (t *Tracker) episodeLocked(subject Subject, now time.Time, create bool) *episode {
	if now.Sub(t.pruned) >= time.Minute {
		t.pruned = now
		for key, current := range t.episodes {
			if now.Sub(current.lastEvent) >= idleExpiry {
				delete(t.episodes, key)
			}
		}
	}
	key := subjectKey{subject.Name, subject.ID}
	current := t.episodes[key]
	if current == nil && create {
		if t.episodes == nil {
			t.episodes = map[subjectKey]*episode{}
		}
		current = &episode{started: now}
		t.episodes[key] = current
	}
	if current != nil {
		current.lastEvent = now
	}
	return current
}

// Failed records a request that failed. attrs describe its last attempt (stage, relay, error). The change into
// failing is logged at warn with them; further failures are counted and summarised every Reminder.
func (t *Tracker) Failed(logger *slog.Logger, subject Subject, attrs ...any) {
	now := t.now()
	t.mu.Lock()
	current := t.episodeLocked(subject, now, true)
	current.failed++
	var message string
	args := []any{subject.IDAttr, subject.ID}
	switch {
	case current.state != failing:
		if current.state == retrying {
			args = append(args, "retried_before", current.retried)
		}
		current.state, current.since, current.reported, current.unreported = failing, now, now, 0
		message = subject.Name + " failing"
	case now.Sub(current.reported) >= t.reminder():
		args = append(args, "failed", current.unreported+1, "failing_for", now.Sub(current.since).Round(time.Second).String())
		current.reported, current.unreported = now, 0
		message = subject.Name + " still failing"
	default:
		current.unreported++
		t.mu.Unlock()
		return
	}
	t.mu.Unlock()
	if logger != nil {
		level := slog.LevelWarn
		if t.Errors {
			level = slog.LevelError
		}
		logger.Log(context.Background(), level, message, append(args, attrs...)...)
	}
}

// Retried records a request that succeeded only after failed attempts or a hold. attrs describe the last failed
// attempt. It is logged at info when the subject starts needing retries or stops failing, and summarised every
// Reminder while it keeps needing them.
func (t *Tracker) Retried(logger *slog.Logger, subject Subject, attrs ...any) {
	now := t.now()
	t.mu.Lock()
	current := t.episodeLocked(subject, now, true)
	current.retried++
	var message string
	args := []any{subject.IDAttr, subject.ID}
	switch {
	case current.state == 0:
		current.state, current.since, current.reported, current.unreported = retrying, now, now, 0
		message = subject.Name + " succeed only after retries"
	case current.state == failing:
		args = append(args, "failed", current.failed, "failing_for", now.Sub(current.since).Round(time.Second).String())
		current.state, current.since, current.reported, current.unreported = retrying, now, now, 0
		message = subject.Name + " succeed again after retries"
	case now.Sub(current.reported) >= t.reminder():
		args = append(args, "retried", current.unreported+1, "retrying_for", now.Sub(current.since).Round(time.Second).String())
		current.reported, current.unreported = now, 0
		message = subject.Name + " still succeed only after retries"
	default:
		current.unreported++
		t.mu.Unlock()
		return
	}
	t.mu.Unlock()
	if logger != nil {
		logger.Info(message, append(args, attrs...)...)
	}
}

// Succeeded records a request that succeeded at once. It ends the subject's episode, if any, with one info line.
func (t *Tracker) Succeeded(logger *slog.Logger, subject Subject) {
	now := t.now()
	t.mu.Lock()
	current := t.episodeLocked(subject, now, false)
	if current == nil {
		t.mu.Unlock()
		return
	}
	delete(t.episodes, subjectKey{subject.Name, subject.ID})
	t.mu.Unlock()
	if logger != nil {
		logger.Info(subject.Name+" recovered", subject.IDAttr, subject.ID, "failed", current.failed, "retried", current.retried,
			"episode", now.Sub(current.started).Round(time.Second).String())
	}
}

// Noted records an expected outcome that deserves a line but no warning (a stream its target ended by restarting
// without handing it over). The first one of a subject is logged at info with attrs; further ones are counted and
// summarised at info every Reminder. Use a Tracker of its own for noted outcomes.
func (t *Tracker) Noted(logger *slog.Logger, subject Subject, what string, attrs ...any) {
	now := t.now()
	t.mu.Lock()
	current := t.episodeLocked(subject, now, true)
	args := []any{subject.IDAttr, subject.ID}
	switch {
	case current.reported.IsZero():
		current.since, current.reported, current.unreported = now, now, 0
	case now.Sub(current.reported) >= t.reminder():
		args = append(args, "count", current.unreported+1, "since", now.Sub(current.since).Round(time.Second).String())
		current.reported, current.unreported = now, 0
	default:
		current.unreported++
		t.mu.Unlock()
		return
	}
	t.mu.Unlock()
	if logger != nil {
		logger.Info(subject.Name+" "+what, append(args, attrs...)...)
	}
}
