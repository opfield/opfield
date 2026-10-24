#!/bin/sh
# Opfield nginx upgrade helper: brings the host's nginx up to the version Opfield requires from the nginx.org stable
# packages, keeps the nginx configuration and the nginx service definition as they were, and hands the running nginx
# over to the new binary without closing a connection.
#
#   install  (root, the default)  add the nginx.org repository with its signing key checked against the pinned
#            fingerprints and upgrade the nginx package; the running nginx keeps serving with the old binary
#   swap     (root or the user of the nginx master)  hand the running nginx over to the installed binary: USR2 starts
#            the new master on the inherited listening sockets, WINCH and QUIT let the old one finish its connections
#   upgrade  (root)  install, then swap
#   watch    (root, run by the opfield-nginx-upgrade OpenRC service)  install whenever the nginx daemon asks for it
#
# It takes nothing from its caller but the mode. The installer (scripts/setup-node.sh) carries this text and writes it
# to /usr/local/libexec/opfield-nginx-upgrade; the nginx daemon embeds the same text
# (packages/daemons/nginx/internal/nginxupgrade/nginx-upgrade.sh, a test keeps both identical).

ONU_MIN_VERSION=1.30.6
ONU_STATE_DIR=/var/lib/opfield-nginx-upgrade
ONU_STATUS_FILE=$ONU_STATE_DIR/status
ONU_REQUEST_FILE=$ONU_STATE_DIR/request/upgrade
ONU_LOCK_DIR=/run/opfield-nginx-upgrade.lock
# The keys of https://nginx.org/keys/nginx_signing.key, as https://nginx.org/en/linux_packages.html lists them.
ONU_PGP_FINGERPRINTS="573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62 8540A6F18833A80E9C1653A42FD21310B49F6B46 9E9BE90EACBCDE69FE9B204CBCDCD8A38D88A2B3"
ONU_PGP_KEY_URL=https://nginx.org/keys/nginx_signing.key
# https://nginx.org/keys/nginx_signing.rsa.pub, whose modulus matches the one linux_packages.html lists.
ONU_RSA_PUB_SHA256=ff7cf138acc09f2a5029300ab713fe6a1440605fca72e2bab76a4da9206fec87
ONU_RSA_PUB_URL=https://nginx.org/keys/nginx_signing.rsa.pub
# The RHEL major whose nginx.org packages Fedora uses: EL9 builds run on every x86-64-v2 CPU and with Fedora's
# libraries; the EL10 ones need x86-64-v3.
ONU_RPM_FEDORA_EL=9

onu_err() { printf 'opfield-nginx-upgrade: %s\n' "$*" >&2; }

onu_version() { nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9][0-9.]*\).*#\1#p' | head -n 1; }

onu_at_least() {
    case "$1" in '' | *[!0-9.]*) return 1 ;; esac
    awk -v a="$1" -v b="$2" 'BEGIN {
        n = split(a, x, "."); m = split(b, y, ".")
        for (i = 1; i <= 3; i++) {
            p = (i <= n) ? x[i] + 0 : 0; q = (i <= m) ? y[i] + 0 : 0
            if (p > q) exit 0
            if (p < q) exit 1
        }
        exit 0
    }'
}

onu_os_field() { sed -n "s/^$1=//p" /etc/os-release 2>/dev/null | head -n 1 | tr -d "\"'"; }

onu_family() {
    case " $(onu_os_field ID) $(onu_os_field ID_LIKE) " in
        *" alpine "*) echo alpine ;;
        *" debian "* | *" ubuntu "*) echo debian ;;
        *" rhel "* | *" fedora "* | *" centos "*) echo rhel ;;
        *) echo unknown ;;
    esac
}

onu_fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 2 -o "$2" "$1"
    else
        wget -q -O "$2" "$1"
    fi
}

# Every key in the file must be one of the pinned nginx.org keys.
onu_verify_pgp_key() {
    local found fpr
    command -v gpg >/dev/null 2>&1 || { onu_err "gpg is needed to check the nginx.org signing key"; return 1; }
    found=$(gpg --batch --show-keys --with-colons "$1" 2>/dev/null |
        awk -F: '$1 == "pub" { want = 1; next } $1 == "fpr" && want { print $10 } { want = 0 }')
    [ -n "$found" ] || { onu_err "the nginx.org signing key file holds no key"; return 1; }
    for fpr in $found; do
        case " $ONU_PGP_FINGERPRINTS " in
            *" $fpr "*) ;;
            *) onu_err "the nginx.org signing key file holds the unknown key $fpr"; return 1 ;;
        esac
    done
}

onu_apt() {
    DEBIAN_FRONTEND=noninteractive apt-get -q -o DPkg::Lock::Timeout=300 \
        -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

onu_setup_repo_debian() {
    local id codename key
    id=$(onu_os_field ID)
    case "$id" in
        debian | ubuntu) ;;
        *) case " $(onu_os_field ID_LIKE) " in *" ubuntu "*) id=ubuntu ;; *) id=debian ;; esac ;;
    esac
    codename=""
    [ "$id" != ubuntu ] || codename=$(onu_os_field UBUNTU_CODENAME)
    [ -n "$codename" ] || codename=$(onu_os_field VERSION_CODENAME)
    [ -n "$codename" ] || codename=$(lsb_release -cs 2>/dev/null)
    [ -n "$codename" ] || { onu_err "cannot tell the release codename of this system"; return 1; }
    if ! command -v gpg >/dev/null 2>&1; then
        onu_apt update && onu_apt install -y gnupg ca-certificates || return 1
    fi
    key=$(mktemp) || return 1
    if ! onu_fetch "$ONU_PGP_KEY_URL" "$key"; then
        rm -f "$key"
        onu_err "cannot download $ONU_PGP_KEY_URL"
        return 1
    fi
    onu_verify_pgp_key "$key" || { rm -f "$key"; return 1; }
    # apt checks signatures as an unprivileged user, so the keyring stays world-readable.
    gpg --batch --yes --dearmor -o /usr/share/keyrings/nginx-archive-keyring.gpg <"$key" || { rm -f "$key"; return 1; }
    rm -f "$key"
    chmod 0644 /usr/share/keyrings/nginx-archive-keyring.gpg
    printf 'deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/%s %s nginx\n' \
        "$id" "$codename" >/etc/apt/sources.list.d/nginx.list
    printf 'Package: *\nPin: origin nginx.org\nPin: release o=nginx\nPin-Priority: 900\n' >/etc/apt/preferences.d/99nginx
    chmod 0644 /etc/apt/sources.list.d/nginx.list /etc/apt/preferences.d/99nginx
}

onu_setup_repo_rhel() {
    local key release
    if ! command -v gpg >/dev/null 2>&1; then
        if command -v dnf >/dev/null 2>&1; then dnf -y -q install gnupg2 || return 1; else yum -y -q install gnupg2 || return 1; fi
    fi
    key=$(mktemp) || return 1
    if ! onu_fetch "$ONU_PGP_KEY_URL" "$key"; then
        rm -f "$key"
        onu_err "cannot download $ONU_PGP_KEY_URL"
        return 1
    fi
    onu_verify_pgp_key "$key" || { rm -f "$key"; return 1; }
    mkdir -p /etc/pki/rpm-gpg
    cat "$key" >/etc/pki/rpm-gpg/RPM-GPG-KEY-nginx && rm -f "$key" || { rm -f "$key"; return 1; }
    chmod 0644 /etc/pki/rpm-gpg/RPM-GPG-KEY-nginx
    # nginx.org builds for the RHEL majors only: Fedora takes ONU_RPM_FEDORA_EL (its releasever names no nginx.org
    # repository). The priority keeps Fedora's and AppStream's nginx, which would win later updates, out.
    release='$releasever'
    [ "$(onu_os_field ID)" != fedora ] || release=$ONU_RPM_FEDORA_EL
    cat >/etc/yum.repos.d/nginx.repo <<REPO
[nginx-stable]
name=nginx stable repo
baseurl=http://nginx.org/packages/centos/${release}/\$basearch/
gpgcheck=1
enabled=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-nginx
module_hotfixes=true
priority=9
REPO
    chmod 0644 /etc/yum.repos.d/nginx.repo
}

onu_setup_repo_alpine() {
    local release key sum line list
    release=$(onu_os_field VERSION_ID | cut -d. -f1,2)
    case "$release" in [0-9]*.[0-9]*) ;; *) onu_err "cannot tell the Alpine release of this system"; return 1 ;; esac
    key=$(mktemp) || return 1
    if ! onu_fetch "$ONU_RSA_PUB_URL" "$key"; then
        rm -f "$key"
        onu_err "cannot download $ONU_RSA_PUB_URL"
        return 1
    fi
    sum=$(sha256sum "$key" | cut -d' ' -f1)
    if [ "$sum" != "$ONU_RSA_PUB_SHA256" ]; then
        rm -f "$key"
        onu_err "the nginx.org signing key nginx_signing.rsa.pub has SHA-256 $sum, not the pinned $ONU_RSA_PUB_SHA256"
        return 1
    fi
    cat "$key" >/etc/apk/keys/nginx_signing.rsa.pub && rm -f "$key" || { rm -f "$key"; return 1; }
    chmod 0644 /etc/apk/keys/nginx_signing.rsa.pub
    line="@nginx https://nginx.org/packages/alpine/v${release}/main"
    if ! grep -qxF "$line" /etc/apk/repositories; then
        list=$(mktemp) || return 1
        grep -v '^@nginx[[:space:]]' /etc/apk/repositories >"$list"
        printf '%s\n' "$line" >>"$list"
        cat "$list" >/etc/apk/repositories
        rm -f "$list"
    fi
}

onu_setup_repo() {
    case "$(onu_family)" in
        alpine) onu_setup_repo_alpine ;;
        debian) onu_setup_repo_debian ;;
        rhel) onu_setup_repo_rhel ;;
        *) onu_err "nginx.org has no stable packages for $(onu_os_field ID); upgrade nginx to ${ONU_MIN_VERSION} or newer with the system's packages"; return 1 ;;
    esac
}

# The nginx.org package, downloaded and checked first: its signature, and that its nginx runs on this host (the EL10
# builds need an x86-64-v3 CPU). An installed nginx is replaced in one rpm transaction without the old package's
# scriptlets (removing it would stop nginx), so the running master keeps serving until the swap. Fedora and RHEL split
# their nginx into nginx, nginx-core, nginx-filesystem and nginx-mimetypes, whose files the single nginx.org package
# also ships: it takes them over, and the split packages go, again without scriptlets. Modules built for the
# distribution's nginx do not load into the nginx.org one, so a host with them is left alone.
onu_install_rpm_nginx() {
    local dir modules package output
    modules=$(rpm -qa 'nginx-mod-*' 'nginx-all-modules' 2>/dev/null | tr '\n' ' ')
    if [ -n "$modules" ]; then
        onu_err "the distribution's nginx modules $modules do not load into the nginx.org nginx; remove them or upgrade nginx by hand"
        return 1
    fi
    dir=$(mktemp -d) || return 1
    if command -v dnf >/dev/null 2>&1; then
        dnf -y -q download --repo nginx-stable --destdir "$dir" nginx
    else
        yumdownloader --disablerepo='*' --enablerepo=nginx-stable --destdir "$dir" nginx
    fi || { rm -rf "$dir"; onu_err "could not download the nginx.org package"; return 1; }
    package=$(ls "$dir"/nginx-[0-9]*.rpm 2>/dev/null | sort -V | tail -n 1)
    [ -n "$package" ] || { rm -rf "$dir"; onu_err "dnf downloaded no nginx.org package"; return 1; }
    rpm --import /etc/pki/rpm-gpg/RPM-GPG-KEY-nginx || { rm -rf "$dir"; return 1; }
    if ! rpm -K "$package" | grep -q 'signatures OK'; then
        rm -rf "$dir"
        onu_err "the downloaded nginx.org package ${package##*/} has no valid nginx.org signature"
        return 1
    fi
    mkdir "$dir/root"
    (cd "$dir/root" && { rpm2archive - <"$package" | tar -xzf - ./usr/sbin/nginx; } 2>/dev/null ||
        { rpm2cpio "$package" | cpio -idm ./usr/sbin/nginx; } 2>/dev/null)
    if ! output=$("$dir/root/usr/sbin/nginx" -v 2>&1) || ! printf '%s' "$output" | grep -q 'nginx/'; then
        rm -rf "$dir"
        onu_err "the nginx.org build ${package##*/} does not run on this host: $(printf '%s' "$output" | head -n 1)"
        return 1
    fi
    if rpm -q nginx >/dev/null 2>&1 || rpm -q nginx-core >/dev/null 2>&1; then
        rpm -U --oldpackage --replacefiles --nopreun --nopostun "$package" || { rm -rf "$dir"; return 1; }
        for package in nginx-core nginx-filesystem nginx-mimetypes; do
            if rpm -q "$package" >/dev/null 2>&1; then
                rpm -e --nodeps --noscripts "$package" || { rm -rf "$dir"; return 1; }
            fi
        done
    elif command -v dnf >/dev/null 2>&1; then
        dnf -y -q install "$package" || { rm -rf "$dir"; return 1; }
    else
        yum -y -q localinstall "$package" || { rm -rf "$dir"; return 1; }
    fi
    rm -rf "$dir"
}

onu_install_package() {
    local status blocked=0
    case "$(onu_family)" in
        alpine)
            apk add --no-cache --upgrade nginx@nginx
            ;;
        debian)
            # The running nginx keeps serving through the package change; the swap hands it over afterwards.
            if [ ! -e /usr/sbin/policy-rc.d ]; then
                printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d && chmod 0755 /usr/sbin/policy-rc.d && blocked=1
            fi
            onu_apt update && onu_apt install -y nginx
            status=$?
            [ "$blocked" -eq 0 ] || rm -f /usr/sbin/policy-rc.d
            return "$status"
            ;;
        rhel)
            onu_install_rpm_nginx
            ;;
        *) return 1 ;;
    esac
}

onu_norm_run() { case "$1" in /var/run/*) printf '/run/%s\n' "${1#/var/run/}" ;; *) printf '%s\n' "$1" ;; esac; }

# The pid file nginx.conf names, empty when it names none.
onu_explicit_pid_file() {
    local file
    file=$(sed -nE 's/^[[:space:]]*pid[[:space:]]+([^;[:space:]]+)[[:space:]]*;.*/\1/p' /etc/nginx/nginx.conf 2>/dev/null | tail -n 1)
    [ -n "$file" ] || file=$(nginx -T 2>/dev/null | sed -nE 's/^[[:space:]]*pid[[:space:]]+([^;[:space:]]+)[[:space:]]*;.*/\1/p' | tail -n 1)
    printf '%s\n' "$file" | tr -d "\"'"
}

onu_compiled_pid_file() { nginx -V 2>&1 | tr ' ' '\n' | sed -n 's/^--pid-path=//p' | head -n 1; }

onu_pid_file() {
    local file
    file=$(onu_explicit_pid_file)
    [ -n "$file" ] || file=$(onu_compiled_pid_file)
    [ -n "$file" ] || file=/run/nginx.pid
    printf '%s\n' "$file"
}

onu_read_pid() {
    local pid
    [ -s "$1" ] || return 1
    pid=$(tr -dc '0-9' <"$1")
    [ -n "$pid" ] && [ -d "/proc/$pid" ] || return 1
    printf '%s\n' "$pid"
}

onu_master_uid() {
    local pid
    pid=$(onu_read_pid "$(onu_pid_file)") || { echo 0; return 0; }
    stat -c %u "/proc/$pid" 2>/dev/null || echo 0
}

# The paths the packages own under /etc/nginx and next to it. The trees the nginx daemon writes (the Opfield trees,
# certificates, htpasswd files) are not among them: the daemon keeps working while the package changes. nginx.conf is:
# a package that replaces the distribution's (Debian's nginx-common) installs its own, without the host's includes.
onu_tracked_entries() {
    local path
    for path in /etc/nginx /etc/init.d/nginx* /etc/conf.d/nginx* /etc/logrotate.d/nginx* /etc/default/nginx* \
        /etc/sysconfig/nginx*; do
        if [ -e "$path" ] || [ -L "$path" ]; then
            find "$path" \( -path /etc/nginx/opfield -o -path /etc/nginx/gateway -o -path /etc/nginx/certs \
                -o -path /etc/nginx/htpasswd \) -prune -o -print
        fi
    done | sort
}

onu_tracked_sums() {
    onu_tracked_entries | while IFS= read -r path; do
        if [ -f "$path" ] && [ ! -L "$path" ]; then
            printf '%s %s\n' "$(sha256sum "$path" | cut -d' ' -f1)" "$path"
        fi
    done
}

onu_snapshot() {
    local path
    onu_tracked_entries >"$1/entries"
    onu_tracked_sums >"$1/sums"
    onu_tracked_entries | while IFS= read -r path; do
        if [ -f "$path" ] || [ -L "$path" ]; then
            mkdir -p "$1/files${path%/*}" && cp -a "$path" "$1/files$path"
        fi
    done
}

# Puts back every tracked file the package changed. Of what it added, the copies of files it kept (.apk-new, .dpkg-dist,
# .rpmnew) go, and a configuration file of its own (its default site, which Alpine's nginx.conf would load in the main
# context) stays as a comment: a later package update keeps a changed file, but would bring back a removed one. Files
# the package removed come back too (Fedora's fastcgi.conf, Debian's snippets: configurations include them); its links
# (Debian's modules-enabled, to modules that went with the old package) stay removed.
onu_restore() {
    local path
    onu_tracked_entries >"$1/entries.after"
    onu_tracked_sums >"$1/sums.after"
    awk 'NR == FNR { sum[$2] = $1; next } ($2 in sum) && sum[$2] != $1 { print $2 }' "$1/sums" "$1/sums.after" |
        while IFS= read -r path; do
            cp -a "$1/files$path" "$path" || onu_err "could not put back $path"
        done
    comm -23 "$1/entries" "$1/entries.after" | while IFS= read -r path; do
        if [ -f "$1/files$path" ] && [ ! -L "$1/files$path" ]; then
            mkdir -p "${path%/*}" && cp -a "$1/files$path" "$path" || onu_err "could not put back $path"
        fi
    done
    comm -13 "$1/entries" "$1/entries.after" | sort -r | while IFS= read -r path; do
        case "$path" in
            *.apk-new | *.dpkg-dist | *.dpkg-new | *.dpkg-old | *.rpmnew | *.rpmsave) rm -f "$path" ;;
            /etc/nginx/*.conf)
                if [ -f "$path" ] && [ ! -L "$path" ]; then
                    printf '# Emptied by the Opfield nginx upgrade: the nginx package installed this file, which the\n# configuration of this host did not have.\n' >"$path"
                fi
                ;;
        esac
    done
}

# nginx.org builds keep their temporary files under /var/cache/nginx, which the Alpine package does not create.
onu_prepare_temp_paths() {
    local uid path
    uid=$(onu_master_uid)
    for path in $(nginx -V 2>&1 | tr ' ' '\n' | sed -n 's/^--http-[a-z-]*-temp-path=//p'); do
        if [ ! -d "${path%/*}" ]; then
            mkdir -p "${path%/*}" && chmod 0755 "${path%/*}"
        fi
        # An nginx master that runs as its own user cannot create them itself.
        if [ "$uid" != 0 ]; then
            mkdir -p "$path" && chown "$uid" "$path"
        fi
    done
}

# systemd follows the master through the binary swap with the pid file nginx writes. A unit that names another pid
# file (the nginx.org unit hardcodes /run/nginx.pid in PIDFile=, ExecReload= and ExecStop=; a non-root nginx keeps it in
# /run/nginx) gets the one nginx.conf names, and reload and stop through the main PID systemd tracks.
onu_align_systemd_pid_file() {
    local conf_pid named stale=0
    [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 || return 0
    # The package replaced the unit file under the running service: until systemd reads it again, it reports the
    # unit as not loaded and refuses reload and restart.
    systemctl daemon-reload
    systemctl cat nginx.service >/dev/null 2>&1 || return 0
    conf_pid=$(onu_norm_run "$(onu_pid_file)")
    [ "$(onu_norm_run "$(systemctl show -p PIDFile nginx.service 2>/dev/null | sed 's/^PIDFile=//')")" = "$conf_pid" ] || stale=1
    for named in $(systemctl cat nginx.service 2>/dev/null | grep -v '^[[:space:]]*#' | grep -o '/[A-Za-z0-9._/-]*\.pid' | sort -u); do
        [ "$(onu_norm_run "$named")" = "$conf_pid" ] || stale=1
    done
    [ "$stale" -eq 1 ] || return 0
    mkdir -p /etc/systemd/system/nginx.service.d
    printf '%s\n' '# Opfield nginx upgrade: the pid file nginx.conf names, reload and stop through the main PID.' '[Service]' \
        "PIDFile=$conf_pid" 'ExecReload=' 'ExecReload=/bin/kill -s HUP $MAINPID' 'ExecStop=' \
        'ExecStop=/bin/kill -s TERM $MAINPID' >/etc/systemd/system/nginx.service.d/opfield-pid-file.conf
    systemctl daemon-reload
}

onu_service_enabled() {
    if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
        systemctl is-enabled nginx.service >/dev/null 2>&1
    else
        [ -e /etc/runlevels/default/nginx ]
    fi
}

onu_enable_service() {
    if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
        systemctl enable nginx.service >/dev/null 2>&1
    elif command -v rc-update >/dev/null 2>&1; then
        rc-update add nginx default >/dev/null 2>&1
    fi
}

# nginx -t for the user the master runs as. As root, nginx hands its temporary directories to the user of its
# configuration (nginx.org builds: nginx), which a master that runs as another user cannot write; run as that user
# instead, it cannot bind ports below 1024 without the capability its service gives it. So root tests with that user
# named, unless nginx.conf names one itself.
onu_test_config() {
    local uid user group
    uid=$(onu_master_uid)
    if [ "$uid" = 0 ] || [ "$(id -u)" != 0 ] ||
        grep -Eq '^[[:space:]]*user[[:space:]]' /etc/nginx/nginx.conf 2>/dev/null; then
        nginx -t -q
        return
    fi
    user=$(awk -F: -v uid="$uid" '$3 == uid { print $1; exit }' /etc/passwd)
    [ -n "$user" ] || { onu_err "no user has uid $uid"; return 1; }
    group=$(id -gn "$user") || return 1
    nginx -t -q -g "user $user $group;"
}

onu_status() {
    local tmp
    mkdir -p "$ONU_STATE_DIR" && chmod 0755 "$ONU_STATE_DIR"
    tmp="$ONU_STATUS_FILE.$$"
    {
        printf 'state=%s\n' "$1"
        printf 'from=%s\n' "$2"
        printf 'to=%s\n' "$3"
        printf 'at=%s\n' "$(date +%s)"
        printf 'error=%s\n' "$(printf '%s' "$4" | tr '\n\t' '  ' | cut -c 1-1000)"
    } >"$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$ONU_STATUS_FILE"
}

onu_lock() {
    if ! mkdir "$ONU_LOCK_DIR" 2>/dev/null; then
        # A run that died without its trap (power loss keeps /run clean) cannot hold it for longer than two hours.
        if [ -n "$(find "$ONU_LOCK_DIR" -maxdepth 0 -mmin +120 2>/dev/null)" ] && rmdir "$ONU_LOCK_DIR" 2>/dev/null &&
            mkdir "$ONU_LOCK_DIR" 2>/dev/null; then
            :
        else
            onu_err "another nginx upgrade is running"
            return 1
        fi
    fi
    trap 'rmdir "$ONU_LOCK_DIR" 2>/dev/null' EXIT
    trap 'exit 1' INT TERM
}

onu_fail() {
    onu_status failed "$1" "$2" "$3"
    onu_err "$3"
    return 1
}

onu_install() {
    local from to old_default work enabled=0 out
    [ "$(id -u)" = 0 ] || { onu_err "the nginx upgrade must run as root"; return 1; }
    rm -f "$ONU_REQUEST_FILE"
    from=$(onu_version)
    if onu_at_least "$from" "$ONU_MIN_VERSION"; then
        onu_status current "$from" "$from" ""
        echo "nginx $from is current"
        return 0
    fi
    [ -n "$from" ] || from=none
    onu_status running "$from" "" ""
    # nginx.org builds keep their pid file in /run/nginx.pid. An nginx.conf that names none (Alpine's keeps it in
    # /run/nginx/nginx.pid) gets the one it has now, which the nginx service and the running master use.
    if [ "$from" != none ] && [ -z "$(onu_explicit_pid_file)" ]; then
        old_default=$(onu_norm_run "$(onu_compiled_pid_file)")
        if [ -n "$old_default" ] && [ "$old_default" != /run/nginx.pid ]; then
            if ! { printf '# The pid file of the nginx this host ran before the nginx.org package (Opfield nginx upgrade).\npid %s;\n\n' \
                "$old_default" && cat /etc/nginx/nginx.conf; } >/etc/nginx/nginx.conf.opfield-new ||
                ! cat /etc/nginx/nginx.conf.opfield-new >/etc/nginx/nginx.conf; then
                rm -f /etc/nginx/nginx.conf.opfield-new
                onu_fail "$from" "" "could not name the pid file ${old_default} in nginx.conf"
                return 1
            fi
            rm -f /etc/nginx/nginx.conf.opfield-new
        fi
    fi
    mkdir -p "$ONU_STATE_DIR/work" && chmod 0700 "$ONU_STATE_DIR/work" || return 1
    work=$(mktemp -d "$ONU_STATE_DIR/work/run.XXXXXX") || return 1
    onu_service_enabled && enabled=1
    onu_snapshot "$work"
    if ! onu_setup_repo >"$work/log" 2>&1; then
        out=$(tail -n 5 "$work/log")
        rm -rf "$work"
        onu_fail "$from" "" "could not add the nginx.org repository: $out"
        return 1
    fi
    if ! onu_install_package >>"$work/log" 2>&1; then
        out=$(tail -n 5 "$work/log")
        onu_restore "$work"
        rm -rf "$work"
        onu_fail "$from" "$(onu_version)" "the nginx.org package did not install: $out"
        return 1
    fi
    onu_restore "$work"
    rm -rf "$work"
    [ "$enabled" -eq 0 ] || onu_service_enabled || onu_enable_service
    onu_prepare_temp_paths
    onu_align_systemd_pid_file
    to=$(onu_version)
    if [ -z "$to" ]; then
        onu_fail "$from" "" "the installed nginx does not run, so the running nginx keeps the old binary: $(nginx -v 2>&1 | head -n 1)"
        return 1
    fi
    if ! onu_at_least "$to" "$ONU_MIN_VERSION"; then
        onu_fail "$from" "$to" "the nginx.org repository offers nginx $to, older than $ONU_MIN_VERSION"
        return 1
    fi
    if ! out=$(onu_test_config 2>&1); then
        onu_fail "$from" "$to" "nginx $to is installed, but the configuration fails its test with it, so the running nginx keeps the old binary: $out"
        return 1
    fi
    onu_status installed "$from" "$to" ""
    echo "nginx $to is installed (was $from)"
}

onu_swap() {
    local pid_file old new exe out i
    pid_file=$(onu_pid_file)
    if ! old=$(onu_read_pid "$pid_file"); then
        echo "nginx is not running; it starts with the installed binary"
        return 0
    fi
    exe=$(readlink "/proc/$old/exe" 2>/dev/null) || { onu_err "cannot inspect the nginx master $old"; return 1; }
    case "$exe" in
        *" (deleted)") ;;
        *) echo "nginx (master $old) runs the installed binary"; return 0 ;;
    esac
    if ! out=$(onu_test_config 2>&1); then
        onu_err "the installed nginx fails the configuration test, so the running nginx keeps its binary: $out"
        return 1
    fi
    if [ -e "$pid_file.oldbin" ]; then
        onu_err "$pid_file.oldbin exists: an earlier binary swap has not finished"
        return 1
    fi
    kill -USR2 "$old" || { onu_err "cannot signal the nginx master $old"; return 1; }
    new=""
    i=0
    while [ "$i" -lt 20 ]; do
        sleep 1
        i=$((i + 1))
        if [ -s "$pid_file.oldbin" ] && new=$(onu_read_pid "$pid_file") && [ "$new" != "$old" ]; then
            break
        fi
        new=""
    done
    if [ -z "$new" ]; then
        onu_err "the new nginx binary did not start (see the nginx error log); the old one keeps serving"
        return 1
    fi
    sleep 2
    if [ ! -d "/proc/$new" ]; then
        onu_err "the new nginx master $new exited (see the nginx error log); the old one keeps serving"
        return 1
    fi
    kill -WINCH "$old" 2>/dev/null
    sleep 1
    kill -QUIT "$old" 2>/dev/null
    echo "nginx $(onu_version) serves as master $new; the old master $old finishes its connections and exits"
}

onu_watch() {
    [ "$(id -u)" = 0 ] || { onu_err "the nginx upgrade must run as root"; return 1; }
    while :; do
        if [ -e "$ONU_REQUEST_FILE" ] || [ -L "$ONU_REQUEST_FILE" ]; then
            (onu_lock && onu_install) || true
        fi
        sleep 15
    done
}

onu_main() {
    case "${1:-install}" in
        install) onu_lock && onu_install ;;
        upgrade) onu_lock && onu_install && onu_swap ;;
        swap) onu_swap ;;
        watch) onu_watch ;;
        *) onu_err "usage: $0 [install|upgrade|swap|watch]"; return 2 ;;
    esac
}

if [ "${ONU_LIBRARY:-0}" != 1 ]; then
    set -u
    umask 022
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    export PATH
    onu_main "$@"
fi
