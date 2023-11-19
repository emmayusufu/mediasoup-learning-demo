"use client";

import { useEffect, useRef, useState } from "react";
// import { css } from "@emotion/css";
import { io } from "socket.io-client";
import { Device } from "mediasoup-client";
import {
  DtlsParameters,
  IceCandidate,
  IceParameters,
  Transport,
} from "mediasoup-client/lib/types";

export default function Home() {
  /**
   * References to the local and remote video HTML elements.
   * These refs are used to attach media streams to the video elements for playback.
   */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  /**
   * State to hold encoding parameters for the media stream.
   * Encoding parameters control the quality and bandwidth usage of the transmitted video.
   * Each object in the encoding array represents a different layer of encoding,
   * allowing for scalable video coding (SVC). The parameters defined here are:
   * - rid: The encoding layer identifier.
   * - maxBitrate: The maximum bitrate for this layer.
   * - scalabilityMode: The scalability mode which specifies the temporal and spatial scalability.
   *
   * Additionally, codecOptions are provided to control the initial bitrate.
   */
  const [params, setParams] = useState({
    encoding: [
      { rid: "r0", maxBitrate: 100000, scalabilityMode: "S1T3" }, // Lowest quality layer
      { rid: "r1", maxBitrate: 300000, scalabilityMode: "S1T3" }, // Middle quality layer
      { rid: "r2", maxBitrate: 900000, scalabilityMode: "S1T3" }, // Highest quality layer
    ],
    codecOptions: { videoGoogleStartBitrate: 1000 }, // Initial bitrate
  });

  /**
   * State to hold references to various mediasoup client-side entities.
   * These entities are crucial for managing the media transmission and reception.
   */
  const [device, setDevice] = useState<Device | null>(null); // mediasoup Device
  const [socket, setSocket] = useState<any>(null); // Socket for signaling
  const [rtpCapabilities, setRtpCapabilities] = useState<any>(null); // RTP Capabilities for the device
  const [producerTransport, setProducerTransport] = useState<Transport | null>(
    null
  ); // Transport for sending media
  const [consumerTransport, setConsumerTransport] = useState<any>(null); // Transport for receiving media

  /**
   * Effect to initialize the socket connection on component mount.
   * The socket is used for signaling to coordinate media transmission.
   * On successful connection, the camera is started to obtain a media stream.
   */
  useEffect(() => {
    const socket = io("http://localhost:4000/mediasoup");

    setSocket(socket);
    socket.on("connection-success", (data) => {
      startCamera();
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  /**
   * Function to start the camera and obtain a media stream.
   * This stream is then attached to the local video element for preview.
   */
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) {
        const track = stream.getVideoTracks()[0];
        videoRef.current.srcObject = stream;
        setParams((current) => ({ ...current, track }));
      }
    } catch (error) {
      console.error("Error accessing camera:", error);
    }
  };

  /**
   * Step 1: Retrieve the Router's RTP Capabilities.
   * This function requests the router's RTP capabilities from the server,
   * which are essential to configure the mediasoup Device.
   * The router's RTP capabilities describe the codecs and RTP parameters supported by the router.
   * This information is crucial for ensuring that the Device is compatible with the router.
   */
  const getRouterRtpCapabilities = async () => {
    socket.emit("getRouterRtpCapabilities", (data: any) => {
      setRtpCapabilities(data.routerRtpCapabilities);
      console.log(`getRouterRtpCapabilities: ${data.routerRtpCapabilities}`);
    });
  };

  /**
   * Step 2: Create and Initialize the mediasoup Device.
   * This function creates a new mediasoup Device instance and loads the router's RTP capabilities into it.
   * The Device is a client-side entity that provides an API for managing sending/receiving media with a mediasoup server.
   * Loading the router's RTP capabilities ensures that the Device is aware of the codecs and RTP parameters it needs to use
   * to successfully send and receive media with the server.
   *
   * If the Device is unable to load the router's RTP capabilities (e.g., due to an unsupported browser),
   * an error is logged to the console.
   */
  const createDevice = async () => {
    try {
      const newDevice = new Device();

      await newDevice.load({ routerRtpCapabilities: rtpCapabilities });

      setDevice(newDevice);
    } catch (error: any) {
      console.log(error);
      if (error.name === "UnsupportedError") {
        console.error("Browser not supported");
      }
    }
  };

  /**
   * Step 3: Create a Transport for Sending Media.
   * This function initiates the creation of a transport on the server-side for sending media,
   * and then replicates the transport on the client-side using the parameters returned by the server.
   */
  const createSendTransport = async () => {
    // Request the server to create a send transport
    socket.emit(
      "createTransport",
      { sender: true },
      ({
        params,
      }: {
        params: {
          /**
           * A unique identifier generated by mediasoup for the transport.
           * Necessary for differentiating between multiple transports.
           */
          id: string;
          /**
           * Interactive Connectivity Establishment (ICE) parameters.
           * Necessary for the negotiation of network connections.
           */
          iceParameters: IceParameters;
          /**
           * Array of ICE candidates.
           * Necessary for establishing network connectivity through NATs and firewalls.
           */
          iceCandidates: IceCandidate[];
          /**
           * Datagram Transport Layer Security (DTLS) parameters.
           * Necessary for securing the transport with encryption.
           */
          dtlsParameters: DtlsParameters;
          /**
           * Error object if any error occurs during transport creation.
           * */
          error?: unknown;
        };
      }) => {
        if (params.error) {
          console.log(params.error);
          return;
        }

        /**
         * Replicate the send transport on the client-side.
         * The `device.createSendTransport` method creates a send transport instance on the client-side
         * using the parameters provided by the server.
         */
        let transport = device?.createSendTransport(params);

        // Update the state to hold the reference to the created transport
        setProducerTransport(transport || null);

        /**
         * Event handler for the "connect" event on the transport.
         * This event is triggered when the transport is ready to be connected.
         * The `dtlsParameters` are provided by the transport and are required to establish
         * the DTLS connection between the client and the server.
         * This event it emitted as a result of calling the `producerTransport?.produce(params)`
         * method in the next step. The event will only be emitted if this is the first time
         */
        transport?.on(
          "connect",
          async ({ dtlsParameters }: any, callback: any, errback: any) => {
            try {
              console.log("----------> producer transport has connected");
              // Notify the server that the transport is ready to connect with the provided DTLS parameters
              socket.emit("connectProducerTransport", { dtlsParameters });
              // Callback to indicate success
              callback();
            } catch (error) {
              // Errback to indicate failure
              errback(error);
            }
          }
        );

        /**
         * Event handler for the "produce" event on the transport.
         * This event is triggered when the transport is ready to start producing media.
         * The `parameters` object contains the necessary information for producing media,
         * including the kind of media (audio or video) and the RTP parameters.
         * The event is emitted as a result of calling the `producerTransport?.produce(params)`
         * method in the next step.
         */
        transport?.on(
          "produce",
          async (parameters: any, callback: any, errback: any) => {
            const { kind, rtpParameters } = parameters;

            console.log("----------> transport-produce");

            try {
              // Notify the server to start producing media with the provided parameters
              socket.emit(
                "transport-produce",
                { kind, rtpParameters },
                ({ id }: any) => {
                  // Callback to provide the server-generated producer ID back to the transport
                  callback({ id });
                }
              );
            } catch (error) {
              // Errback to indicate failure
              errback(error);
            }
          }
        );
      }
    );
  };

  /**
   * Step 4: Connect the Send Transport and Start Producing Media.
   * This function initiates the process of producing media using the previously created send transport.
   */
  const connectSendTransport = async () => {
    /**
     * This instructs the transport to start sending media to the router.
     * The transport will emit a "connect" event if this is the first time the transport is being connected.
     * Before this method completes, the transport will emit a "produce" event which was
     * was subscribed to in the previous step so the application will transmit the event parameters to the server.
     * */
    let localProducer = await producerTransport?.produce(params);

    // Event handlers for track ending and transport closing events
    localProducer?.on("trackended", () => {
      console.log("trackended");
    });
    localProducer?.on("transportclose", () => {
      console.log("transportclose");
    });
  };

  /**
   * Step 5: Create a Transport for Receiving Media.
   * This function initiates the creation of a transport on the server-side for receiving media,
   * and then replicates the transport on the client-side using the parameters returned by the server.
   */
  const createRecvTransport = async () => {
    // Requesting the server to create a receive transport
    socket.emit(
      "createTransport",
      { sender: false },
      ({ params }: { params: any }) => {
        if (params.error) {
          console.log(params.error);
          return;
        }

        // Creating a receive transport on the client-side using the server-provided parameters
        let transport = device?.createRecvTransport(params);
        setConsumerTransport(transport);

        /**
         * This event is triggered when "consumerTransport.consume" is called
         * for the first time on the client-side.
         * */
        transport?.on(
          "connect",
          async ({ dtlsParameters }: any, callback: any, errback: any) => {
            try {
              // Notifying the server to connect the receive transport with the provided DTLS parameters
              await socket.emit("connectConsumerTransport", { dtlsParameters });
              console.log("----------> consumer transport has connected");
              callback();
            } catch (error) {
              errback(error);
            }
          }
        );
      }
    );
  };

  /**
   * Step 6: Connect the Receive Transport and Start Consuming Media.
   * This function initiates the process of consuming media using the previously created receive transport.
   */
  const connectRecvTransport = async () => {
    // Requesting the server to start consuming media
    await socket.emit(
      "consumeMedia",
      { rtpCapabilities: device?.rtpCapabilities },
      async ({ params }: any) => {
        if (params.error) {
          console.log(params.error);
          return;
        }

        // Consuming media using the receive transport
        let consumer = await consumerTransport.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        });

        // Accessing the media track from the consumer
        const { track } = consumer;
        console.log("************** track", track);

        // Attaching the media track to the remote video element for playback
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = new MediaStream([track]);
        }

        // Notifying the server to resume media consumption
        socket.emit("resumePausedConsumer", () => {});
        console.log("----------> consumer transport has resumed");
      }
    );
  };

  return (
    <main>
      <video ref={videoRef} id="localvideo" autoPlay playsInline />
      <video ref={remoteVideoRef} id="remotevideo" autoPlay playsInline />
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <button onClick={getRouterRtpCapabilities}>
          Get Router RTP Capabilities
        </button>
        <button onClick={createDevice}>Create Device</button>
        <button onClick={createSendTransport}>Create send transport</button>
        <button onClick={connectSendTransport}>
          Connect send transport and produce
        </button>
        <button onClick={createRecvTransport}>Create recv transport</button>
        <button onClick={connectRecvTransport}>
          Connect recv transport and consume
        </button>
      </div>
    </main>
  );
}
