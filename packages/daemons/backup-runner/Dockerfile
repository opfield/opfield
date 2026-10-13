FROM docker.io/library/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a

# The base image ships only its own major's client. pg_dump/pg_restore must match
# the server's major, so install one client per major the managed catalog offers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-paramiko rclone redis-tools ca-certificates \
    postgresql-client-14 postgresql-client-15 postgresql-client-16 postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 65532 --create-home --shell /usr/sbin/nologin opfield-backup
COPY opfield-backup-runner.py /usr/local/bin/opfield-backup-runner
RUN chmod 0555 /usr/local/bin/opfield-backup-runner

# Verify the actual dependency/runtime combination for every published platform.
COPY opfield-backup-runner.py test_runner.py /tmp/runner-tests/
RUN PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s /tmp/runner-tests -p 'test_*.py' \
  && rm -r /tmp/runner-tests

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/opfield-backup-runner"]
