import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SSLCertificate } from "@/types";

const NO_CERTIFICATE = "__none__";

/**
 * The certificate a system route (the status page, the access sign-in domain) presents: "No
 * certificate" or one of the active certificates.
 */
export function SystemRouteCertificateSelect({
  value,
  certificates,
  disabled,
  onChange,
  id,
}: {
  value: string | null;
  certificates: SSLCertificate[];
  disabled?: boolean;
  onChange: (sslCertificateId: string | null) => void;
  id?: string;
}) {
  return (
    <Select
      value={value ?? NO_CERTIFICATE}
      disabled={disabled}
      onValueChange={(next) => onChange(next === NO_CERTIFICATE ? null : next)}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_CERTIFICATE}>No certificate</SelectItem>
        {certificates
          .filter((cert) => cert.status === "active")
          .map((cert) => (
            <SelectItem key={cert.id} value={cert.id}>
              {cert.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
