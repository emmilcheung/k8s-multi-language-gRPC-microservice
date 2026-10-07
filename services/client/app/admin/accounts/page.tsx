import { ReasonForm } from "@/components/admin/reason-form";
import { suspendAccountAction } from "@/app/actions/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function AdminAccountsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Suspend an organizer account</CardTitle>
        <CardDescription>
          A suspended organizer account cannot sell tickets or change its events. Its team keeps read access.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ReasonForm action={suspendAccountAction} submitLabel="Suspend account">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="accountId">Organizer account id</Label>
            <Input id="accountId" name="accountId" required />
          </div>
        </ReasonForm>
      </CardContent>
    </Card>
  );
}
