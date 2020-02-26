import Stripe from "stripe";
import * as functions from "firebase-functions";
import * as logs from "./logs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2019-12-03"
});

interface InvoicePayload {
  email: string;
  items: [OrderItem];
}

interface OrderItem {
  amount: number;
  currency: string;
  description: string;
}

const createInvoice = async function(
  customer: Stripe.Customer,
  orderItems: Array<OrderItem>
) {
  try {
    // Create an invoice item for each item in the datastore JSON
    const itemPromises: Array<Promise<Stripe.InvoiceItem>> = orderItems.map(
      item => {
        return stripe.invoiceItems.create({
          customer: customer.id,
          amount: item.amount,
          currency: item.currency,
          description: item.description
        });
      }
    );

    // Create the individual invoice items for this customer
    const items: Array<Stripe.InvoiceItem> = await Promise.all(itemPromises);

    // Create an invoice
    const invoice: Stripe.Invoice = await stripe.invoices.create({
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: 7, // TODO: Make this configurable with default of 7 days
      auto_advance: true
    });

    return invoice;
  } catch (e) {
    logs.stripeError(e);
    return null;
  }
};

// TODO: Use Firestore instead of realtime db and have it take collection name
export const sendInvoice = functions.handler.database.ref.onCreate(
  async snap => {
    try {
      const payload = JSON.parse(snap.val()) as InvoicePayload;

      if (!payload.email || !payload.items.length) {
        console.log("Malformed payload", payload);
        return;
      }

      logs.start();

      // Check to see if we already have a Customer record in Stripe with email address
      let customers: Stripe.ApiList<
        Stripe.Customer
      > = await stripe.customers.list({ email: payload.email });
      let customer: Stripe.Customer;

      if (customers.data.length) {
        customer = customers.data[0];
        logs.customerRetrieved(customer.id, payload.email);
      } else {
        // Create new Customer on Stripe with email
        // TODO: Allow more customization of Customer information (e.g. name)
        customer = await stripe.customers.create({
          email: payload.email,
          metadata: {
            createdFrom: "Created by Firebase extension" // optional metadata, adds a note
          }
        });

        logs.customerCreated(customer.id);
      }

      const invoice: Stripe.Invoice = await createInvoice(
        customer,
        payload.items
      );

      if (invoice.id) {
        // Stripe sends an email to the customer
        const result: Stripe.Invoice = await stripe.invoices.sendInvoice(
          invoice.id
        );
        if (result.status === "open") {
          logs.invoiceSent(result.id, payload.email, result.hosted_invoice_url);
        }
      } else {
        logs.invoiceCreatedError(invoice);
      }
    } catch (e) {
      logs.error(e);
    }
    return;
  }
);
