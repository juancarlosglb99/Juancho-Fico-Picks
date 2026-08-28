import { AdminView } from '../components/admin-view';

/**
 * The admin page.
 *
 * The shell is public; the DATA is not. Every request this page makes goes to a
 * route that resolves the caller from their session cookie and reads the
 * entitlement table, and those routes answer 404 to anybody who is not an
 * active admin. So a customer who guesses this URL gets an empty "Not found"
 * panel and no information - there is nothing here for a browser to lie its way
 * past, because nothing it sends is consulted.
 */
export default function AdminPage() {
  return <AdminView />;
}
