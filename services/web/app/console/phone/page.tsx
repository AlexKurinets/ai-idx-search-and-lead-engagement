import Phone from '@/components/Phone';
import { PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function PhonePage({ searchParams }: { searchParams: Promise<{ handset?: string }> }) {
  const { handset } = await searchParams;
  return (
    <>
      <PageHeader
        title="Sandbox phone"
        sub="Outbound texts land here instead of a carrier. Replies are posted to the inbound webhook with a valid signature, so they take the production path."
      />
      <Phone initial={handset} />
    </>
  );
}
