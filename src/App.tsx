import React, { FC, useMemo, useState, useEffect } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import {
  WalletModalProvider,
  WalletDisconnectButton,
  WalletMultiButton,
} from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Program, AnchorProvider, web3, BN } from '@project-serum/anchor';
import { PublicKey, TokenAmount } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';

// Import the IDL
import idl from './idl/virtual_pet.json';

require('@solana/wallet-adapter-react-ui/styles.css');

const App: FC = () => {
  const network = WalletAdapterNetwork.Devnet;
  const endpoint = useMemo(() => clusterApiUrl(network), [network]);
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
    ],
    [network]
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="App">
            <header>
              <WalletMultiButton />
              <WalletDisconnectButton />
            </header>
            <main>
              <PetSystem />
            </main>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

const PetSystem: FC = () => {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [program, setProgram] = useState<any>(null);
  const [provider, setProvider] = useState<AnchorProvider | null>(null);
  const [pet, setPet] = useState<any>(null);
  const [petCoinBalance, setPetCoinBalance] = useState<number>(0);
  const [items, setItems] = useState<any[]>([]);
  const [selectedPet, setSelectedPet] = useState<string>('');
  const [ownershipRequests, setOwnershipRequests] = useState<any[]>([]);
  
  // Initialize the program
  useEffect(() => {
    const init = async () => {
      if (wallet.connected && wallet.publicKey && wallet.signTransaction && wallet.signAllTransactions && connection) {
        try {
          // Pre-checks for IDL and its metadata
          if (!idl || typeof idl !== 'object') {
            console.error("IDL is not loaded or is not an object. Please check the import from './idl/virtual_pet.json'.");
            setProvider(null);
            setProgram(null);
            return;
          }
          if (!idl.metadata || typeof idl.metadata !== 'object') {
            console.error("IDL 'metadata' field is missing or not an object. Check './idl/virtual_pet.json'.");
            setProvider(null);
            setProgram(null);
            return;
          }
          const programAddressString = (idl as any).address;
          if (typeof programAddressString !== 'string' || programAddressString.trim() === '') {
            console.error("IDL 'metadata.address' is missing, not a string, or empty. Check './idl/virtual_pet.json'.");
            setProvider(null);
            setProgram(null);
            return;
          }

          // Create an adapter for the wallet to match AnchorProvider's expected Wallet interface
          const anchorWallet = {
            publicKey: wallet.publicKey,
            signTransaction: async (tx: web3.Transaction) => {
              // The useWallet hook's signTransaction is generic and might return VersionedTransaction
              // AnchorProvider expects a function that specifically signs and returns a web3.Transaction.
              // We assert that wallet.signTransaction is defined due to the check above.
              return wallet.signTransaction!(tx);
            },
            signAllTransactions: async (txs: web3.Transaction[]) => {
              // Similar to signTransaction, adapt for signAllTransactions.
              // We assert that wallet.signAllTransactions is defined.
              return wallet.signAllTransactions!(txs);
            },
          };

          const newProvider = new AnchorProvider(
            connection,
            anchorWallet, // Use the adapted wallet
            AnchorProvider.defaultOptions()
          );
          setProvider(newProvider);
          
          const programId = new PublicKey(programAddressString); // Use validated address string
          const newProgram = new Program(idl as any, programId, newProvider);
          setProgram(newProgram);
          
          await loadPetData(newProgram, wallet.publicKey);
        } catch (error) {
          console.error('Error initializing program:', error);
          // Enhanced error message for BN-related issues
          if (error instanceof TypeError && (error.message.includes("_bn") || error.message.toLowerCase().includes("bn"))) {
            console.error(
              "This error often indicates an issue with the program's IDL file ('./idl/virtual_pet.json'). " +
              "It could be related to the definition of large number types (e.g., u64, i64), constants, " +
              "or other structures within the IDL. Please carefully review your IDL file for correctness."
            );
            // Optionally, log parts of the IDL that might be relevant if known
            if (idl && idl.metadata) {
              console.log("IDL metadata for context:", JSON.stringify(idl.metadata));
            }
          }
        }
      } else {
        setProvider(null);
        setProgram(null);
        setPet(null);
        setPetCoinBalance(0);
      }
    };
    init();
  }, [wallet.connected, wallet.publicKey, connection, wallet.signTransaction, wallet.signAllTransactions]); // Added wallet.signTransaction and wallet.signAllTransactions to dependencies for completeness

  const loadPetData = async (currentProgram: any, owner: PublicKey) => {
    if (!currentProgram) {
      console.log("loadPetData: program not available");
      setPet(null);
      return;
    }
    try {
      const [petPDA] = await PublicKey.findProgramAddress(
        [Buffer.from('pet'), owner.toBuffer()],
        currentProgram.programId
      );
      
      const petAccount = await currentProgram.account.pet.fetch(petPDA);
      setPet({
        ...petAccount,
        publicKey: petPDA,
      });
      
      await loadPetCoinBalance(currentProgram, owner);
      await loadItems(currentProgram, owner);
      await loadOwnershipRequests(currentProgram, owner);
    } catch (error) {
      console.error('Error loading pet data:', error);
    }
  };
  
  const initializePet = async () => {
    if (!program || !provider || !wallet.publicKey) return;
    
    try {
      const [petPDA] = await PublicKey.findProgramAddress(
        [Buffer.from('pet'), wallet.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods.initializePet()
        .accounts({
          pet: petPDA,
          owner: wallet.publicKey,
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc();
      
      await loadPetData(program, wallet.publicKey);
    } catch (error) {
      console.error('Error initializing pet:', error);
    }
  };
  
  const requestOwnership = async () => {
    if (!program || !provider || !selectedPet || !wallet.publicKey) return;
    
    try {
      const toPubkey = new PublicKey(selectedPet);
      const [requestPDA] = await PublicKey.findProgramAddress(
        [
          Buffer.from('ownership_request'),
          wallet.publicKey.toBuffer(),
          toPubkey.toBuffer(),
        ],
        program.programId
      );
      
      await program.methods.requestOwnership()
        .accounts({
          ownershipRequest: requestPDA,
          from: wallet.publicKey,
          to: toPubkey,
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc();
      
      alert('Ownership request sent!');
    } catch (error) {
      console.error('Error requesting ownership:', error);
    }
  };
  
  const respondToRequest = async (request: any, accept: boolean) => {
    if (!program || !provider || !wallet.publicKey) return;
    
    try {
      await program.methods.respondToRequest(accept)
        .accounts({
          ownershipRequest: request.publicKey,
          pet: request.pet,
          to: wallet.publicKey,
        })
        .rpc();
      
      await loadPetData(program, wallet.publicKey);
      await loadOwnershipRequests(program, wallet.publicKey);
    } catch (error) {
      console.error('Error responding to request:', error);
    }
  };
  
  const feedPet = async (itemId: number) => {
    if (!program || !provider || !pet || !wallet.publicKey) return;
    
    try {
      const item = items.find(i => i.id === itemId);
      if (!item) return;
      
      await program.methods.feedPet(itemId)
        .accounts({
          pet: pet.publicKey,
          owner: wallet.publicKey,
          feeder: wallet.publicKey,
          item: item.publicKey,
          itemMint: item.mint,
          itemTokenAccount: item.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      
      await loadPetData(program, wallet.publicKey);
      await loadItems(program, wallet.publicKey);
    } catch (error) {
      console.error('Error feeding pet:', error);
    }
  };
  
  const playWithPet = async () => {
    if (!program || !provider || !pet || !wallet.publicKey) return;
    
    try {
      await program.methods.playWithPet()
        .accounts({
          pet: pet.publicKey,
          owner: wallet.publicKey,
        })
        .rpc();
      
      await loadPetData(program, wallet.publicKey);
    } catch (error) {
      console.error('Error playing with pet:', error);
    }
  };
  
  const earnCoins = async () => {
    if (!program || !provider || !pet || !wallet.publicKey) return;
    
    try {
      const petCoinMint = await getPetCoinMint(program);
      
      const ownerTokenAccountAddress = await getAssociatedTokenAddress(
        petCoinMint,
        wallet.publicKey
      );

      const accountInfo = await provider.connection.getAccountInfo(ownerTokenAccountAddress);
      if (!accountInfo) {
        const transaction = new web3.Transaction().add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey, // payer
            ownerTokenAccountAddress, // ata
            wallet.publicKey, // owner
            petCoinMint       // mint
          )
        );
        // The provider's wallet will be used as the fee payer and signer
        await provider.sendAndConfirm(transaction, []);
      }
      
      await program.methods.earnCoins()
        .accounts({
          pet: pet.publicKey,
          owner: wallet.publicKey,
          petCoinMint,
          ownerTokenAccount: ownerTokenAccountAddress,
          petCoinMintAuthority: wallet.publicKey, // Assuming this is the mint authority for PetCoin
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      
      await loadPetData(program, wallet.publicKey);
      await loadPetCoinBalance(program, wallet.publicKey);
    } catch (error) {
      console.error('Error earning coins:', error);
    }
  };
  
  const loadPetCoinBalance = async (program: any, owner: PublicKey) => {
    if (!program || !program.provider || !owner) return;
    try {
      const petCoinMint = await getPetCoinMint(program);
      
      const tokenAccountAddress = await getAssociatedTokenAddress(
        petCoinMint,
        owner
      );

      // Check if ATA exists, create if not. Payer is the connected wallet.
      const accountInfo = await program.provider.connection.getAccountInfo(tokenAccountAddress);
      if (!accountInfo) {
        const transaction = new web3.Transaction().add(
          createAssociatedTokenAccountInstruction(
            program.provider.wallet.publicKey, // payer (connected wallet)
            tokenAccountAddress, // ata
            owner, // owner of the ATA
            petCoinMint // mint
          )
        );
        await program.provider.sendAndConfirm(transaction, []);
      }
      
      const balance = await program.provider.connection.getTokenAccountBalance(
        tokenAccountAddress
      );
      
      setPetCoinBalance(Number(balance.value.amount));
    } catch (error) {
      console.error('Error loading pet coin balance:', error);
    }
  };
  
  const loadItems = async (program: any, owner: PublicKey) => {
    const mockItems = [
      { id: 1, name: 'Healthy Food', healthEffect: 20, happinessEffect: 5, price: 10 },
      { id: 2, name: 'Treat', healthEffect: 5, happinessEffect: 15, price: 8 },
      { id: 3, name: 'Toy', healthEffect: 0, happinessEffect: 25, price: 15 },
    ];
    setItems(mockItems);
  };
  
  const loadOwnershipRequests = async (program: any, owner: PublicKey) => {
    const mockRequests: any[] = [];
    setOwnershipRequests(mockRequests);
  };
  
  const getPetCoinMint = async (program: any): Promise<PublicKey> => {
    const mintAddress = process.env.REACT_APP_PET_COIN_MINT_ADDRESS;
    if (!mintAddress) {
      const errorMessage = "Configuration Error: REACT_APP_PET_COIN_MINT_ADDRESS environment variable is not set. The application cannot function correctly without it.";
      console.error(errorMessage);
      // Alert the user or throw an error to prevent further execution with invalid config
      alert(errorMessage); 
      throw new Error(errorMessage);
    }
    return new PublicKey(mintAddress);
  };
  
  const buyItem = async (itemId: number) => {
    if (!program || !provider || !pet || !wallet.publicKey) return;
    
    try {
      const item = items.find(i => i.id === itemId);
      if (!item) {
        alert('Item not found!');
        return;
      }
      
      if (petCoinBalance < item.price) {
        alert('Not enough Pet Coins!');
        return;
      }

      // Placeholder for actual transaction
      // This assumes your smart contract has a 'buyItem' instruction
      // and you have a defined treasury account for receiving PetCoins.
      // You'll need to replace 'YOUR_TREASURY_PET_COIN_ATA_PUBKEY'
      // with the actual public key of the treasury's associated token account.

      const petCoinMint = await getPetCoinMint(program);
      const ownerPetCoinTokenAccount = await getAssociatedTokenAddress(
        petCoinMint,
        wallet.publicKey
      );

      // Example: A fixed treasury account public key.
      // In a real scenario, this might be a PDA or a configurable address.
      const treasuryPublicKey = new PublicKey("YOUR_TREASURY_ACCOUNT_PUBKEY_HERE"); // Replace with actual treasury owner
      const treasuryPetCoinTokenAccount = await getAssociatedTokenAddress(
        petCoinMint,
        treasuryPublicKey 
      );
      
      // Ensure treasury ATA exists, or create it (this might be handled by the contract or require pre-setup)
      // For simplicity, this example assumes it exists.

      /*
      // Hypothetical smart contract call
      await program.methods.buyItem(new BN(item.id), new BN(item.price)) // Adjust parameters as per your IDL
        .accounts({
          pet: pet.publicKey, // If the item is tied to the pet or pet's state changes
          owner: wallet.publicKey,
          ownerPetCoinTokenAccount: ownerPetCoinTokenAccount,
          treasuryPetCoinTokenAccount: treasuryPetCoinTokenAccount, // Account to send coins to
          petCoinMint: petCoinMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          // Potentially other accounts like an item mint, item account, etc.
          // systemProgram: web3.SystemProgram.programId, // If creating accounts
        })
        .rpc();
      */
      
      // Remove this alert or move it inside the .then() of the rpc() call upon successful transaction
      alert(`Purchased ${item.name}! (Simulated - Implement actual transaction)`); 
      
      await loadPetCoinBalance(program, wallet.publicKey);
      await loadItems(program, wallet.publicKey); // Or update inventory specifically
    } catch (error) {
      console.error('Error buying item:', error);
      alert(`Error buying item: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  
  return (
    <div className="pet-system">
      {!pet ? (
        <div>
          <h2>Welcome to Solana Virtual Pets!</h2>
          <button onClick={initializePet}>Create Your Pet</button>
        </div>
      ) : (
        <div>
          <h2>Your Pet</h2>
          <div className="pet-status">
            <p>Health: {pet.health}/100</p>
            <p>Happiness: {pet.happiness}/100</p>
            <p>Pet Coins: {petCoinBalance}</p>
          </div>
          
          <div className="pet-actions">
            <button onClick={playWithPet}>Play with Pet</button>
            <button onClick={earnCoins}>Earn Coins</button>
          </div>
          
          <div className="ownership-section">
            <h3>Ownership</h3>
            <input
              type="text"
              placeholder="Enter user's public key"
              value={selectedPet}
              onChange={(e) => setSelectedPet(e.target.value)}
            />
            <button onClick={requestOwnership}>Request Ownership</button>
            
            {ownershipRequests.length > 0 && (
              <div className="requests">
                <h4>Ownership Requests</h4>
                {ownershipRequests.map((request) => (
                  <div key={request.publicKey.toString()}>
                    <p>From: {request.from.toString()}</p>
                    <button onClick={() => respondToRequest(request, true)}>Accept</button>
                    <button onClick={() => respondToRequest(request, false)}>Reject</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <div className="shop-section">
            <h3>Item Shop</h3>
            <div className="items">
              {items.map((item) => (
                <div key={item.id} className="item">
                  <h4>{item.name}</h4>
                  <p>Health: +{item.healthEffect}</p>
                  <p>Happiness: +{item.happinessEffect}</p>
                  <p>Price: {item.price} Pet Coins</p>
                  <button onClick={() => buyItem(item.id)}>Buy</button>
                  <button onClick={() => feedPet(item.id)}>Use</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;