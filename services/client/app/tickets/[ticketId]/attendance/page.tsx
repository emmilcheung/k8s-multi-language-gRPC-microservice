import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ ticketId: string }>;
}

export default async function AttendanceSettingsPage({ params }: Props) {
  const { ticketId } = await params;
  redirect(`/organizer/events/${ticketId}/attendance`);
}
