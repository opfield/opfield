package docker

import (
	"context"
	"errors"
	"testing"
	"time"
)

func waitTaskStatus(t *testing.T, m *TaskManager, id string, want TaskStatus) Task {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if task, ok := m.Get(id); ok && task.Status == want {
			return task
		}
		time.Sleep(5 * time.Millisecond)
	}
	task, _ := m.Get(id)
	t.Fatalf("task %s: status %q, want %q", id, task.Status, want)
	return Task{}
}

// Gateway asks for an update's task by the command that started it when it lost the answer that named the task.
func TestTaskManagerFindsTaskByItsOpfieldCommand(t *testing.T) {
	m := NewTaskManager()
	release := make(chan struct{})
	task, err := m.SubmitForCommand("cmd-1", "api", "update", time.Minute, func(context.Context) error {
		<-release
		return errors.New("pull access denied")
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.CommandID != "cmd-1" {
		t.Fatalf("command ID %q", task.CommandID)
	}
	byCommand, ok := m.Get("cmd-1")
	if !ok || byCommand.ID != task.ID || byCommand.Type != "update" {
		t.Fatalf("by command: %+v %v", byCommand, ok)
	}
	close(release)
	failed := waitTaskStatus(t, m, "cmd-1", TaskFailed)
	if failed.ID != task.ID || failed.Error != "pull access denied" {
		t.Fatalf("finished task by command: %+v", failed)
	}
	if _, ok := m.Get("cmd-2"); ok {
		t.Fatal("a command this daemon never ran must not be found")
	}

	// A task without a command is found by its own ID only; finished tasks go with their command IDs.
	plain, err := m.Submit("web", "recreate", time.Minute, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	waitTaskStatus(t, m, plain.ID, TaskSucceeded)
	if _, ok := m.Get(""); ok {
		t.Fatal("an empty command ID must not find a task")
	}
	m.prune(time.Now().Add(time.Hour))
	if _, ok := m.Get("cmd-1"); ok {
		t.Fatal("a pruned task must not be found by its command")
	}
	if _, ok := m.Get(task.ID); ok {
		t.Fatal("a pruned task must not be found")
	}
}
