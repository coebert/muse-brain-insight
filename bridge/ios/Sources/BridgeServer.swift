// Local WebSocket server. Safari on the same iPhone connects to
// ws://127.0.0.1:<port>, which browsers treat as a secure context, so the
// https MindGuard page is allowed to open it.

import Foundation
import Network

final class BridgeServer {
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private let queue = DispatchQueue(label: "mindguard.bridge.ws")
    private var lastHello: Data?

    private(set) var port: UInt16 = 0

    var clientCount: Int {
        queue.sync { connections.count }
    }

    func start(port: UInt16) throws {
        stop()
        let parameters = NWParameters.tcp
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        parameters.allowLocalEndpointReuse = true
        parameters.includePeerToPeer = true

        let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connection.start(queue: self.queue)
            self.queue.async {
                self.connections.append(connection)
                if let hello = self.lastHello { self.send(hello, to: connection) }
            }
            self.receive(connection)
        }
        listener.start(queue: queue)
        self.listener = listener
        self.port = port
    }

    func stop() {
        listener?.cancel()
        listener = nil
        queue.async {
            for connection in self.connections { connection.cancel() }
            self.connections.removeAll()
            self.lastHello = nil
        }
    }

    private func receive(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] _, _, _, error in
            guard let self else { return }
            if error != nil {
                self.queue.async { self.connections.removeAll { $0 === connection } }
                return
            }
            self.receive(connection)
        }
    }

    /// Broadcasts one JSON object to every attached browser tab.
    func broadcast(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        if (object["type"] as? String) == "hello" { queue.async { self.lastHello = data } }
        queue.async {
            for connection in self.connections { self.send(data, to: connection) }
        }
    }

    private func send(_ data: Data, to connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "json", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }
}
