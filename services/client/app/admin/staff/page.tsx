import { ReasonForm } from "@/components/admin/reason-form";
import { changePlatformRoleAction } from "@/app/actions/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const selectClass = "h-8 rounded-md border border-line bg-page px-2 text-sm text-ink";

export default function AdminStaffPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform staff roles</CardTitle>
        <CardDescription>Grant or remove platform admin and platform support for a user.</CardDescription>
      </CardHeader>
      <CardContent>
        <ReasonForm action={changePlatformRoleAction} submitLabel="Apply change">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">User email</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="role">Role</Label>
            <select id="role" name="role" defaultValue="platform_support" className={selectClass}>
              <option value="platform_support">Platform support</option>
              <option value="platform_admin">Platform admin</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="action">Change</Label>
            <select id="action" name="action" defaultValue="grant" className={selectClass}>
              <option value="grant">Grant</option>
              <option value="remove">Remove</option>
            </select>
          </div>
        </ReasonForm>
      </CardContent>
    </Card>
  );
}
