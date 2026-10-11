import { Minus, Plus } from "lucide-react";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { SwitchCard } from "@/components/common/SwitchCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CertificatePolicy, CertificateType, CustomExtension, KeyAlgorithm } from "@/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KEY_USAGE_OPTIONS = [
  {
    value: "digitalSignature",
    label: "Digital Signature",
    desc: "The certificate can be used to verify digital signatures. Required for TLS and most use cases.",
  },
  {
    value: "keyEncipherment",
    label: "Key Encipherment",
    desc: "The certificate can be used to encrypt symmetric keys (e.g., during TLS handshake with RSA key exchange).",
  },
  {
    value: "dataEncipherment",
    label: "Data Encipherment",
    desc: "The certificate can be used to encrypt data directly. Rarely needed.",
  },
  {
    value: "keyAgreement",
    label: "Key Agreement",
    desc: "The certificate can be used in key agreement protocols (e.g., ECDH).",
  },
  {
    value: "nonRepudiation",
    label: "Non-Repudiation",
    desc: "The signer cannot deny having signed. Used for legal/compliance scenarios.",
  },
];

export const EXT_KEY_USAGE_OPTIONS = [
  {
    value: "serverAuth",
    label: "TLS Server Authentication",
    desc: "Allows the certificate to be used as an HTTPS/TLS server certificate.",
  },
  {
    value: "clientAuth",
    label: "TLS Client Authentication",
    desc: "Allows the certificate to be used for mutual TLS (mTLS) client authentication.",
  },
  {
    value: "codeSigning",
    label: "Code Signing",
    desc: "Allows the certificate to sign executables, libraries, and software packages.",
  },
  {
    value: "emailProtection",
    label: "Email Protection (S/MIME)",
    desc: "Allows the certificate to sign and encrypt emails.",
  },
  {
    value: "timeStamping",
    label: "Time Stamping",
    desc: "Allows the certificate to create trusted timestamps for documents.",
  },
  {
    value: "ocspSigning",
    label: "OCSP Signing",
    desc: "Allows the certificate to sign OCSP responses for certificate revocation checks.",
  },
];

const SAN_TYPE_OPTIONS = [
  { value: "dns", label: "DNS Names", desc: "Domain names like example.com or *.example.com" },
  { value: "ip", label: "IP Addresses", desc: "IPv4 or IPv6 addresses" },
  { value: "email", label: "Email Addresses", desc: "Email addresses for S/MIME certificates" },
  { value: "uri", label: "URIs", desc: "Full URIs like https://example.com/path" },
];

export const WIZARD_STEPS = [
  { id: "general", title: "General", subtitle: "Name, type, and basic settings" },
  { id: "keyUsage", title: "Key Usage", subtitle: "What the certificate key can do" },
  { id: "extKeyUsage", title: "Purpose", subtitle: "What the certificate is used for" },
  { id: "san", title: "SANs", subtitle: "Subject Alternative Name rules" },
  { id: "subject", title: "Subject DN", subtitle: "Organization identity fields" },
  { id: "distribution", title: "Endpoints", subtitle: "CRL and OCSP URLs" },
  { id: "policies", title: "Policies", subtitle: "Certificate policy OIDs" },
  { id: "extensions", title: "Custom", subtitle: "Raw X.509 extensions" },
];

export function toggleInArray(arr: string[], value: string): string[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

// ---------------------------------------------------------------------------
// Step Components
// ---------------------------------------------------------------------------

export function StepGeneral({
  name,
  setName,
  description,
  setDescription,
  certType,
  setCertType,
  keyAlgorithm,
  setKeyAlgorithm,
  validityDays,
  setValidityDays,
}: {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  certType: CertificateType;
  setCertType: (v: CertificateType) => void;
  keyAlgorithm: KeyAlgorithm;
  setKeyAlgorithm: (v: KeyAlgorithm) => void;
  validityDays: number;
  setValidityDays: (v: number) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Give your template a name and configure the basic certificate parameters. These settings
        determine the type of certificate and its cryptographic strength.
      </p>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Mutual TLS Server+Client"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Description</label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this template is for"
        />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Certificate Type</label>
          <Select value={certType} onValueChange={(v) => setCertType(v as CertificateType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tls-server">TLS Server</SelectItem>
              <SelectItem value="tls-client">TLS Client</SelectItem>
              <SelectItem value="code-signing">Code Signing</SelectItem>
              <SelectItem value="email">Email</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Key Algorithm</label>
          <Select value={keyAlgorithm} onValueChange={(v) => setKeyAlgorithm(v as KeyAlgorithm)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rsa-2048">RSA-2048</SelectItem>
              <SelectItem value="rsa-4096">RSA-4096</SelectItem>
              <SelectItem value="ecdsa-p256">ECDSA-P256</SelectItem>
              <SelectItem value="ecdsa-p384">ECDSA-P384</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Validity (days)</label>
          <NumericInput value={validityDays} onChange={setValidityDays} min={1} max={3650} />
        </div>
      </div>
    </div>
  );
}

export function StepKeyUsage({
  keyUsage,
  setKeyUsage,
}: {
  keyUsage: string[];
  setKeyUsage: (v: string[]) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Key Usage defines what cryptographic operations the certificate's key is allowed to perform.
        If you're unsure, select <strong>Digital Signature</strong> (used by almost everything) and{" "}
        <strong>Key Encipherment</strong> (needed for RSA-based TLS).
      </p>
      <div className="space-y-2">
        {KEY_USAGE_OPTIONS.map((opt) => (
          <CheckboxCard
            key={opt.value}
            checked={keyUsage.includes(opt.value)}
            onCheckedChange={() => setKeyUsage(toggleInArray(keyUsage, opt.value))}
            label={opt.label}
            description={opt.desc}
          />
        ))}
      </div>
      {keyUsage.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No key usage selected — the certificate type default will be used.
        </p>
      )}
    </div>
  );
}

export function StepExtKeyUsage({
  extKeyUsage,
  setExtKeyUsage,
  customEkuOid,
  setCustomEkuOid,
}: {
  extKeyUsage: string[];
  setExtKeyUsage: (v: string[]) => void;
  customEkuOid: string;
  setCustomEkuOid: (v: string) => void;
}) {
  const customOids = extKeyUsage.filter((e) => !EXT_KEY_USAGE_OPTIONS.some((o) => o.value === e));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Extended Key Usage specifies the <strong>purpose</strong> of the certificate — what
        applications will accept it for. For example, a web server certificate needs "TLS Server
        Authentication". You can select multiple purposes (e.g., both server and client auth for
        mutual TLS).
      </p>
      <div className="space-y-2">
        {EXT_KEY_USAGE_OPTIONS.map((opt) => (
          <CheckboxCard
            key={opt.value}
            checked={extKeyUsage.includes(opt.value)}
            onCheckedChange={() => setExtKeyUsage(toggleInArray(extKeyUsage, opt.value))}
            label={opt.label}
            description={opt.desc}
          />
        ))}
      </div>

      {customOids.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium">Custom OIDs</p>
          {customOids.map((oid) => (
            <div key={oid} className="flex items-center gap-2">
              <span className="text-xs font-mono flex-1">{oid}</span>
              <Button
                variant="outline"
                size="icon-xs"
                onClick={() => setExtKeyUsage(extKeyUsage.filter((e) => e !== oid))}
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Need a purpose not listed above? Add it by OID.
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={customEkuOid}
            onChange={(e) => setCustomEkuOid(e.target.value)}
            placeholder="e.g., 1.3.6.1.5.5.7.3.8"
            className="flex-1 font-mono text-xs"
          />
          <Button
            variant="outline"
            disabled={!customEkuOid.trim() || !/^\d+(\.\d+)+$/.test(customEkuOid)}
            onClick={() => {
              setExtKeyUsage([...extKeyUsage, customEkuOid.trim()]);
              setCustomEkuOid("");
            }}
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
      </div>

      {extKeyUsage.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No purpose selected — the certificate type default will be used.
        </p>
      )}
    </div>
  );
}

export function StepSAN({
  requireSans,
  setRequireSans,
  sanTypes,
  setSanTypes,
}: {
  requireSans: boolean;
  setRequireSans: (v: boolean) => void;
  sanTypes: string[];
  setSanTypes: (v: string[]) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Subject Alternative Names (SANs) are the identities the certificate protects — domain names,
        IPs, or email addresses. Modern browsers <strong>require</strong> SANs for TLS certificates
        and ignore the Common Name field.
      </p>
      <SwitchCard
        label="Require SANs"
        description="When enabled, certificates using this template must include at least one SAN."
        checked={requireSans}
        onCheckedChange={setRequireSans}
      />
      <div>
        <p className="text-sm font-medium mb-2">Allowed SAN types</p>
        <div className="space-y-2">
          {SAN_TYPE_OPTIONS.map((opt) => (
            <CheckboxCard
              key={opt.value}
              checked={sanTypes.includes(opt.value)}
              onCheckedChange={() => setSanTypes(toggleInArray(sanTypes, opt.value))}
              label={opt.label}
              description={opt.desc}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function StepSubjectDN({
  dnO,
  setDnO,
  dnOu,
  setDnOu,
  dnL,
  setDnL,
  dnSt,
  setDnSt,
  dnC,
  setDnC,
}: {
  dnO: string;
  setDnO: (v: string) => void;
  dnOu: string;
  setDnOu: (v: string) => void;
  dnL: string;
  setDnL: (v: string) => void;
  dnSt: string;
  setDnSt: (v: string) => void;
  dnC: string;
  setDnC: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The Subject Distinguished Name identifies who the certificate belongs to. The Common Name
        (CN) is always set per-certificate. These fields provide <strong>default values</strong> —
        they can be overridden when issuing individual certificates.
      </p>
      <p className="text-xs text-muted-foreground">
        All fields are optional. Leave empty if not needed.
      </p>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Organization (O)</label>
          <Input
            value={dnO}
            onChange={(e) => setDnO(e.target.value)}
            placeholder="e.g., Acme Corp"
          />
          <p className="text-xs text-muted-foreground">The legal name of your organization.</p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Organizational Unit (OU)</label>
          <Input
            value={dnOu}
            onChange={(e) => setDnOu(e.target.value)}
            placeholder="e.g., Engineering"
          />
          <p className="text-xs text-muted-foreground">
            Department or division within the organization.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Locality (L)</label>
            <Input value={dnL} onChange={(e) => setDnL(e.target.value)} placeholder="City" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">State (ST)</label>
            <Input
              value={dnSt}
              onChange={(e) => setDnSt(e.target.value)}
              placeholder="State/Province"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Country (C)</label>
            <Input
              value={dnC}
              onChange={(e) => setDnC(e.target.value)}
              placeholder="US"
              maxLength={2}
            />
            <p className="text-xs text-muted-foreground">2-letter code</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function StepDistribution({
  crlDistributionPoints,
  setCrlDistributionPoints,
  caIssuersUrl,
  setCaIssuersUrl,
}: {
  crlDistributionPoints: string[];
  setCrlDistributionPoints: (v: string[]) => void;
  caIssuersUrl: string;
  setCaIssuersUrl: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Distribution endpoints tell clients where to check revocation lists and where to download
        the issuing CA certificate. These are embedded directly into the certificate.{" "}
        <strong>If your CA already has these configured, you can skip this step</strong> — the CA's
        URLs will be used automatically.
      </p>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">CRL Distribution Points</label>
        <p className="text-xs text-muted-foreground">
          URLs where the Certificate Revocation List can be downloaded. Clients check this to verify
          the certificate hasn't been revoked.
        </p>
        {crlDistributionPoints.map((url, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={url}
              onChange={(e) => {
                const next = [...crlDistributionPoints];
                next[i] = e.target.value;
                setCrlDistributionPoints(next);
              }}
              placeholder="http://crl.example.com/ca.crl"
              className="flex-1 font-mono text-xs"
            />
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() =>
                setCrlDistributionPoints(crlDistributionPoints.filter((_, j) => j !== i))
              }
            >
              <Minus className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          onClick={() => setCrlDistributionPoints([...crlDistributionPoints, ""])}
        >
          <Plus className="h-4 w-4" /> Add CRL URL
        </Button>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">CA Issuers URL</label>
        <p className="text-xs text-muted-foreground">
          Where clients can download the issuing CA certificate to build the trust chain.
        </p>
        <Input
          value={caIssuersUrl}
          onChange={(e) => setCaIssuersUrl(e.target.value)}
          placeholder="http://ca.example.com/cert.pem"
          className="font-mono text-xs"
        />
      </div>
    </div>
  );
}

export function StepPolicies({
  certificatePolicies,
  setCertificatePolicies,
}: {
  certificatePolicies: CertificatePolicy[];
  setCertificatePolicies: (v: CertificatePolicy[]) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Certificate Policies define the rules and practices under which the certificate was issued.
        These are typically required for publicly-trusted certificates or enterprise PKI compliance.
        <strong> Most private/internal PKIs don't need this.</strong>
      </p>
      <div className="space-y-2">
        {certificatePolicies.map((pol, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="flex-1 space-y-1">
              <Input
                value={pol.oid}
                onChange={(e) => {
                  const next = [...certificatePolicies];
                  next[i] = { ...next[i], oid: e.target.value };
                  setCertificatePolicies(next);
                }}
                placeholder="Policy OID (e.g., 2.23.140.1.2.1)"
                className="font-mono text-xs"
              />
              <Input
                value={pol.qualifier || ""}
                onChange={(e) => {
                  const next = [...certificatePolicies];
                  next[i] = { ...next[i], qualifier: e.target.value };
                  setCertificatePolicies(next);
                }}
                placeholder="CPS URI (optional, e.g., https://example.com/cps)"
                className="font-mono text-xs"
              />
            </div>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setCertificatePolicies(certificatePolicies.filter((_, j) => j !== i))}
            >
              <Minus className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          onClick={() =>
            setCertificatePolicies([...certificatePolicies, { oid: "", qualifier: "" }])
          }
        >
          <Plus className="h-4 w-4" /> Add Policy
        </Button>
      </div>
    </div>
  );
}

export function StepCustomExtensions({
  customExtensions,
  setCustomExtensions,
}: {
  customExtensions: CustomExtension[];
  setCustomExtensions: (v: CustomExtension[]) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Add arbitrary X.509 extensions by OID. This is an advanced feature for niche requirements
        (e.g., proprietary extensions, name constraints, or industry-specific OIDs).
        <strong> Most users don't need this.</strong>
      </p>
      <p className="text-xs text-muted-foreground">
        The value must be a <strong>hex-encoded DER</strong> byte string. You'll need to use an
        ASN.1 encoder to produce this. "Critical" means the extension <strong>must</strong> be
        understood by the client — if it doesn't recognize the OID, it will reject the certificate.
      </p>
      <div className="space-y-3">
        {customExtensions.map((ext, i) => (
          <div key={i} className="border border-border p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={ext.oid}
                onChange={(e) => {
                  const next = [...customExtensions];
                  next[i] = { ...next[i], oid: e.target.value };
                  setCustomExtensions(next);
                }}
                placeholder="OID (e.g., 1.2.3.4.5.6.7)"
                className="flex-1 font-mono text-xs"
              />
              <label className="flex items-center gap-1.5 text-xs shrink-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ext.critical}
                  onChange={(e) => {
                    const next = [...customExtensions];
                    next[i] = { ...next[i], critical: e.target.checked };
                    setCustomExtensions(next);
                  }}
                  className="h-3.5 w-3.5"
                />
                Critical
              </label>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => setCustomExtensions(customExtensions.filter((_, j) => j !== i))}
              >
                <Minus className="h-4 w-4" />
              </Button>
            </div>
            <Input
              value={ext.value}
              onChange={(e) => {
                const next = [...customExtensions];
                next[i] = { ...next[i], value: e.target.value };
                setCustomExtensions(next);
              }}
              placeholder="Hex-encoded DER value"
              className="font-mono text-xs"
            />
          </div>
        ))}
        <Button
          variant="outline"
          onClick={() =>
            setCustomExtensions([...customExtensions, { oid: "", critical: false, value: "" }])
          }
        >
          <Plus className="h-4 w-4" /> Add Extension
        </Button>
      </div>
    </div>
  );
}
