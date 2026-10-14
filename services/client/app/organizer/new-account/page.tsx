import { NewAccountForm } from "@/components/organizer/team-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function NewOrganizerAccountPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Become an organizer</CardTitle>
        <CardDescription>
          An organizer account owns your events and sales. You become its owner and can invite your team.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <NewAccountForm />
      </CardContent>
    </Card>
  );
}
