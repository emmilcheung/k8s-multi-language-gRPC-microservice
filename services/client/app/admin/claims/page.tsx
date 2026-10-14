import { ReasonForm } from "@/components/admin/reason-form";
import { decideVenueClaimAction } from "@/app/actions/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function AdminClaimsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Decide a venue claim</CardTitle>
        <CardDescription>
          Approving a claim makes the claimant the venue team of that venue. Enter the claim id from the claim notice.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ReasonForm action={decideVenueClaimAction} submitLabel="Record decision">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="claimId">Claim id</Label>
            <Input id="claimId" name="claimId" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision">Decision</Label>
            <select id="decision" name="decision" defaultValue="APPROVE" className="h-8 rounded-md border border-line bg-page px-2 text-sm text-ink">
              <option value="APPROVE">Approve</option>
              <option value="REJECT">Reject</option>
            </select>
          </div>
        </ReasonForm>
      </CardContent>
    </Card>
  );
}
