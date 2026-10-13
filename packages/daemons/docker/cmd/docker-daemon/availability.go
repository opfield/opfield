package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/config"
	"github.com/opfield/opfield/docker-daemon/internal/docker"
)

// `docker-daemon availability ...`: node-local operations on database and
// storage availability set members, for when Opfield is down. A forced
// promotion (AS10) goes through the lease like any acquisition and is
// refused without a strict majority of the set's voters.
const availabilityUsage = `Usage:
  docker-daemon availability status [--set ID] [--json]
  docker-daemon availability force-promote --set ID --over BALLOT --accept-data-loss [--operation-id ID] [--wait 60s]

force-promote makes this node's member the primary although no copy is
eligible (acknowledged writes may be lost). BALLOT is the newest commit
ballot "availability status" shows ("round.incarnation.node"); the override
expires after five minutes or as soon as a newer commit is seen.`

func runAvailabilityCommand(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, availabilityUsage)
		return 2
	}
	flags := flag.NewFlagSet("availability "+args[0], flag.ContinueOnError)
	flags.SetOutput(stderr)
	set := flags.String("set", "", "availability set id")
	over := flags.String("over", "", "the newest commit ballot you saw (availability status)")
	accept := flags.Bool("accept-data-loss", false, "confirm that acknowledged writes may be lost")
	operation := flags.String("operation-id", "", "audit id of the forced promotion")
	wait := flags.Duration("wait", 60*time.Second, "how long to wait for the promotion")
	jsonOutput := flags.Bool("json", false, "print JSON")
	if err := flags.Parse(args[1:]); err != nil {
		return 2
	}
	switch args[0] {
	case "status":
	case "force-promote":
		if *set == "" || *over == "" {
			fmt.Fprintln(stderr, availabilityUsage)
			return 2
		}
		if !*accept {
			fmt.Fprintln(stderr, "refused: a forced promotion may lose acknowledged writes; confirm with --accept-data-loss")
			return 2
		}
		if _, err := docker.ParseBallot(*over); err != nil {
			fmt.Fprintln(stderr, "refused:", err)
			return 2
		}
	default:
		fmt.Fprintln(stderr, availabilityUsage)
		return 2
	}
	socket, err := availabilityControlSocket()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if args[0] == "status" {
		response, err := availabilityControlCall(socket, docker.AvailabilityControlRequest{Action: "status", SetID: *set})
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if *jsonOutput {
			_ = json.NewEncoder(stdout).Encode(response.Members)
			return 0
		}
		for _, member := range response.Members {
			fmt.Fprintf(stdout, "set %s member %s: %s (lease %s), serving=%v eligible=%v %s lag=%d commit=%s holder=%s\n",
				member.SetID, member.MemberID, member.Role, member.LeaseRole, member.Serving, member.Eligible, member.EligibilityReason,
				member.LagBytes, member.CommitBallot, member.CommitHolder)
		}
		return 0
	}
	response, err := availabilityControlCall(socket, docker.AvailabilityControlRequest{
		Action: "force-promote", SetID: *set, OperationID: *operation, Over: *over, AcceptDataLoss: true,
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "forced promotion %s armed over %s\n", response.Force.OperationID, *over)
	deadline := time.Now().Add(*wait)
	for time.Now().Before(deadline) {
		time.Sleep(time.Second)
		status, err := availabilityControlCall(socket, docker.AvailabilityControlRequest{Action: "force-status", SetID: *set})
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		switch status.Force.Outcome {
		case "acquired":
			fmt.Fprintln(stdout, "this member took the primary role; it serves once its promotion is certified")
			return 0
		case "expired", "superseded":
			fmt.Fprintf(stderr, "forced promotion ended (%s): %s\n", status.Force.Outcome, status.Force.Reason)
			return 1
		}
	}
	fmt.Fprintln(stderr, "the forced promotion has not completed yet; check with `docker-daemon availability status`")
	return 1
}

func availabilityControlSocket() (string, error) {
	path := os.Getenv("DOCKER_DAEMON_CONFIG")
	if path == "" {
		path = "/etc/docker-daemon/config.yaml"
	}
	cfg, err := config.Load(path)
	if err != nil {
		return "", fmt.Errorf("load %s: %w", path, err)
	}
	return docker.AvailabilityControlSocket(cfg.StateDir), nil
}

func availabilityControlCall(socket string, request docker.AvailabilityControlRequest) (docker.AvailabilityControlResponse, error) {
	conn, err := net.DialTimeout("unix", socket, 5*time.Second)
	if err != nil {
		return docker.AvailabilityControlResponse{}, fmt.Errorf("the docker daemon does not answer on %s (is it running on this node?): %w", socket, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return docker.AvailabilityControlResponse{}, err
	}
	var response docker.AvailabilityControlResponse
	if err := json.NewDecoder(conn).Decode(&response); err != nil {
		return docker.AvailabilityControlResponse{}, err
	}
	if response.Error != "" {
		return response, errors.New("refused: " + response.Error)
	}
	return response, nil
}
