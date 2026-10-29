Open a PDF from a thread and read it in place. The plugin shows the document in the panel where Cloudroom normally shows a file preview.

## What you get

- Page navigation, zoom, and text search from your browser PDF viewer.
- A loading indicator while Cloudroom fetches the file and while the viewer renders it.
- A clear error message and a Retry button when the file does not load.

## How it works

The plugin claims the `pdf` extension in Cloudroom's file opener. It works for files in a thread workspace, files on the host machine, and files in thread storage. Cloudroom fetches the file and confirms that the response is a PDF. It then hands the file to the browser viewer inside a frame.

No account, external service, or separate install is required. The browser or app shell must include a PDF viewer. The Cloudroom desktop app includes one.
